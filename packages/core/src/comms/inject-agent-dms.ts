/**
 * Prompt-injection helper for direct messages.
 *
 * The agent runtime calls `injectAgentDms(prompt, agentId, adapter)` before
 * dispatching the next invocation. The helper:
 *
 *   1. Reads up to N undelivered DMs for `agentId`.
 *   2. Renders them as a `## Direct Messages` markdown block.
 *   3. Marks each row `delivered_at = now()` so the next call won't re-inject.
 *
 * This matches the `injectFreshContext` pattern (ADR 0001). The two helpers
 * are intentionally siblings rather than coupled — the order at the call site
 * is: base prompt → fresh context → DMs.
 *
 * Delivery is a side effect of injection; we do not currently track `read_at`.
 * That's a v2 concern (per the spec's Section 3.2 — `status='read'` field).
 */

import type { WorkspaceAdapter } from '@agentforge/db';
import { rowToDirectMessage } from './direct-messages.js';
import type { DirectMessage } from './types.js';

export interface InjectAgentDmsOptions {
  /** Maximum DMs to inject in one shot. Default: 10 (matches spec section 3.4). */
  maxMessages?: number;
  /** Per-DM body cap rendered in the prompt. Default: 4000 characters. */
  maxBodyChars?: number;
  /**
   * When false, skip marking the fetched rows delivered. Useful for callers
   * that want to render a preview without consuming the queue (dashboards).
   */
  markDelivered?: boolean;
}

const DEFAULT_MAX = 10;
const DEFAULT_BODY_CAP = 4000;

/**
 * Build the markdown block for an agent's pending DMs. Returns an empty
 * string when the recipient has none — callers can then skip appending the
 * section entirely.
 */
export function buildAgentDmsBlock(
  adapter: WorkspaceAdapter,
  agentId: string,
  options: InjectAgentDmsOptions = {},
): { block: string; messages: DirectMessage[] } {
  const max = options.maxMessages ?? DEFAULT_MAX;
  const bodyCap = options.maxBodyChars ?? DEFAULT_BODY_CAP;

  const rows = adapter.listDirectMessages({
    toAgent: agentId,
    undeliveredOnly: true,
    limit: max,
  });
  if (rows.length === 0) return { block: '', messages: [] };

  const messages = rows.map(rowToDirectMessage);
  const lines = messages.map((msg) => {
    const body = msg.body.length > bodyCap ? `${msg.body.slice(0, bodyCap - 1)}…` : msg.body;
    const replyTag = msg.replyToId ? ` (re: ${msg.replyToId})` : '';
    // Use one bullet per DM, prefixed by sender + sent-time. Indent the body
    // onto its own line so multi-line markdown renders cleanly.
    return `- **${msg.fromAgent}** at \`${msg.sentAt}\`${replyTag}\n  ${body.replace(/\n/g, '\n  ')}`;
  });

  const block = [
    `## Direct Messages (${messages.length} new)`,
    'These are direct messages from other agents addressed to you. Reply by ' +
      'calling `POST /api/v5/dms` with `replyToId` set to the DM id you are responding to.',
    '',
    lines.join('\n'),
  ].join('\n');

  return { block, messages };
}

/**
 * Append a "Direct Messages" section to the system prompt if any DMs are
 * pending for `agentId`, and mark them delivered. Returns the prompt
 * unchanged when nothing is queued.
 */
export function injectAgentDms(
  prompt: string,
  agentId: string,
  adapter: WorkspaceAdapter,
  options: InjectAgentDmsOptions = {},
): string {
  const { block, messages } = buildAgentDmsBlock(adapter, agentId, options);
  if (!block) return prompt;

  if (options.markDelivered !== false) {
    adapter.markDirectMessagesDelivered(messages.map((m) => m.id));
  }

  return `${prompt.trimEnd()}\n\n${block}\n`;
}
