/**
 * CC Inbox Bridge — T3.5 (Workstream Y)
 *
 * Builds a summary of unread inbox messages for a CC-invoked agent.  The
 * summary is prepended to the agent's task (via the prologue builder) so the
 * agent is aware of pending inbox items without having to poll the API.
 *
 * Design decisions:
 *
 *   - Reads up to `limit` (default 5) unread messages for the given recipient,
 *     ordered newest-first (adapter default).
 *   - Does NOT mark messages as read — the agent must explicitly call
 *     `POST /api/v5/inbox/:id/read` to transition status.  This prevents the
 *     briefing from silently consuming the unread queue.
 *   - Bypasses the `@user`-only check in the comms helper layer by calling
 *     `adapter.listInboxForRecipient` directly. This is intentional: the v1
 *     restriction lives in the `sendInboxMessage` / `listInboxForRecipient`
 *     helper layer and is a write-path guard, not an invariant of the
 *     storage schema.  Agents are valid inbox recipients in the DB.
 *   - The inbox has no `subject` field; the summary uses the first 80 chars of
 *     `body` as a stand-in.  `source_type` and `kind` are shown as context.
 *
 * Returns empty string when the agent has no unread items — caller skips the
 * block.
 */

import type { WorkspaceAdapter } from '@agentforge/db';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface BuildCcInboxBriefingOptions {
  /** Agent (or `@user`) whose unread inbox messages to summarise. */
  agentId: string;
  /** Workspace adapter — provides `listInboxForRecipient`. */
  adapter: WorkspaceAdapter;
  /**
   * Maximum number of unread inbox items to include.
   * Default: 5.
   */
  limit?: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Express an ISO-8601 timestamp as a human-readable relative time string,
 * e.g. "2 hours ago".  Falls back to the raw ISO string when parsing fails.
 *
 * Purely cosmetic — no external dependencies.
 */
function relativeTime(isoTs: string): string {
  const then = Date.parse(isoTs);
  if (Number.isNaN(then)) return isoTs;
  const diffMs = Date.now() - then;
  const diffS = Math.round(diffMs / 1000);
  if (diffS < 60) return 'just now';
  const diffM = Math.round(diffS / 60);
  if (diffM < 60) return `${diffM} minute${diffM === 1 ? '' : 's'} ago`;
  const diffH = Math.round(diffM / 60);
  if (diffH < 24) return `${diffH} hour${diffH === 1 ? '' : 's'} ago`;
  const diffD = Math.round(diffH / 24);
  return `${diffD} day${diffD === 1 ? '' : 's'} ago`;
}

/**
 * Produce a one-line summary of an inbox message body (max 80 chars).
 */
function summariseBody(body: string): string {
  const firstLine = body.split('\n')[0] ?? '';
  const trimmed = firstLine.trim();
  if (trimmed.length <= 80) return trimmed;
  return `${trimmed.slice(0, 79)}…`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build the "## Inbox" summary block for a CC-invoked agent.
 *
 * Returns an empty string when the agent has no unread inbox items.  Does NOT
 * mark messages as read.
 */
export function buildCcInboxBriefing(opts: BuildCcInboxBriefingOptions): string {
  const { agentId, adapter } = opts;
  const limit = opts.limit ?? 5;

  const rows = adapter.listInboxForRecipient({
    recipient: agentId,
    status: 'unread',
    limit,
  });

  if (rows.length === 0) return '';

  const bullets = rows.map((row) => {
    const subject = summariseBody(row.body);
    const sender = row.source_type ?? row.kind;
    const when = relativeTime(row.created_at);
    return `- ${subject} from ${sender} (${when})`;
  });

  return ['## Inbox', '', bullets.join('\n'), ''].join('\n');
}
