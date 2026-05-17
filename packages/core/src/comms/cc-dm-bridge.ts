/**
 * CC DM Bridge — T3.5 (Workstream Y)
 *
 * Delivers undelivered direct messages to a CC-invoked agent by formatting
 * them as a "## Pending messages for you" directive block prepended to the
 * agent's TASK (not the system prompt).  This is the canonical CC-native DM
 * delivery path, distinct from `injectAgentDms` which appends to the system
 * prompt in the CLI path.
 *
 * Callers (e.g. `buildCcAgentPrologue`) should prepend the returned block at
 * the very top of the task string so the user sees pending DMs inline as part
 * of the prompt going to the Agent tool.
 *
 * Delivery is a side-effect of calling `buildCcDmDirectiveBlock` — each
 * fetched DM is marked `delivered_at = now()` via
 * `adapter.markDirectMessagesDelivered()` so subsequent calls skip them.
 * Pass `markDelivered: false` to preview without consuming the queue.
 */

import type { WorkspaceAdapter } from '@agentforge/db';
import { rowToDirectMessage } from './direct-messages.js';
import type { DirectMessage } from './types.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface BuildCcDmDirectiveBlockOptions {
  /** Agent whose undelivered DMs to fetch. */
  agentId: string;
  /** Workspace adapter — provides `listDirectMessages` + `markDirectMessagesDelivered`. */
  adapter: WorkspaceAdapter;
  /**
   * Maximum number of DMs to include in one block.
   * Default: 10 (matches the CLI path cap in `inject-agent-dms.ts`).
   */
  maxMessages?: number;
  /**
   * Per-DM body character cap rendered in the block.
   * Default: 4000 characters.
   */
  maxBodyChars?: number;
  /**
   * When false, skip marking the fetched rows delivered. Useful for preview /
   * dry-run callers (e.g. dashboard previews).  Default: true.
   */
  markDelivered?: boolean;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build the "## Pending messages for you" CC-native directive block.
 *
 * Returns an empty string when the agent has no undelivered DMs — callers
 * should skip prepending the block entirely in that case.
 *
 * Side-effect: marks each fetched DM delivered (unless `markDelivered: false`).
 */
export function buildCcDmDirectiveBlock(opts: BuildCcDmDirectiveBlockOptions): string {
  const { agentId, adapter, markDelivered = true } = opts;
  const max = opts.maxMessages ?? 10;
  const bodyCap = opts.maxBodyChars ?? 4000;

  const rows = adapter.listDirectMessages({
    toAgent: agentId,
    undeliveredOnly: true,
    limit: max,
  });

  if (rows.length === 0) return '';

  const messages: DirectMessage[] = rows.map(rowToDirectMessage);

  const itemLines = messages.map((msg) => {
    const body =
      msg.body.length > bodyCap ? `${msg.body.slice(0, bodyCap - 1)}…` : msg.body;
    // Blockquote each line of the body so multi-line messages render cleanly.
    const quotedBody = body
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n');
    return `**From \`${msg.fromAgent}\` at ${msg.sentAt}:**\n${quotedBody}`;
  });

  const block = [
    '## Pending messages for you',
    '',
    itemLines.join('\n\n'),
    '',
    '---',
    '',
  ].join('\n');

  if (markDelivered) {
    adapter.markDirectMessagesDelivered(messages.map((m) => m.id));
  }

  return block;
}
