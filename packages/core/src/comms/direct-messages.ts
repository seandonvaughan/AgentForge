/**
 * Direct-message helpers — thin wrappers over `WorkspaceAdapter` that produce
 * the public-facing `DirectMessage` shape and centralise validation. Routes
 * and bridges import these instead of touching the adapter directly so that
 * the v1 invariants ("body is required", "replyToId must point at an existing
 * DM") live in one place.
 */

import type { WorkspaceAdapter, DirectMessageRow } from '@agentforge/db';
import type { DirectMessage, SendDirectMessageInput } from './types.js';

function rowToDirectMessage(row: DirectMessageRow): DirectMessage {
  return {
    id: row.id,
    fromAgent: row.from_agent,
    toAgent: row.to_agent,
    body: row.body,
    replyToId: row.reply_to_id,
    sentAt: row.sent_at,
    deliveredAt: row.delivered_at,
  };
}

export { rowToDirectMessage };

/**
 * Persist a DM. Throws on missing fields and on a `replyToId` that does not
 * resolve to an existing row — callers should treat both as bad-request.
 */
export function sendDirectMessage(
  adapter: WorkspaceAdapter,
  input: SendDirectMessageInput,
): DirectMessage {
  const from = input.from?.trim();
  const to = input.to?.trim();
  const body = input.body?.trim();
  if (!from) throw new Error('sendDirectMessage: "from" is required');
  if (!to) throw new Error('sendDirectMessage: "to" is required');
  if (!body) throw new Error('sendDirectMessage: "body" is required');
  if (from === to) {
    throw new Error('sendDirectMessage: "from" and "to" must differ');
  }
  if (input.replyToId) {
    const parent = adapter.getDirectMessage(input.replyToId);
    if (!parent) {
      throw new Error(`sendDirectMessage: replyToId "${input.replyToId}" not found`);
    }
  }
  const row = adapter.createDirectMessage({
    fromAgent: from,
    toAgent: to,
    body,
    ...(input.replyToId ? { replyToId: input.replyToId } : {}),
  });
  return rowToDirectMessage(row);
}

/** List DMs for a single agent — sent or received. Oldest first. */
export function listDirectMessagesForAgent(
  adapter: WorkspaceAdapter,
  agentId: string,
  options: { limit?: number; offset?: number } = {},
): DirectMessage[] {
  const rows = adapter.listDirectMessages({
    agentId,
    ...(options.limit !== undefined ? { limit: options.limit } : {}),
    ...(options.offset !== undefined ? { offset: options.offset } : {}),
  });
  return rows.map(rowToDirectMessage);
}

/**
 * Group DMs into threads by chasing the `replyToId` chain. Each thread is
 * keyed by its root id and ordered oldest-first. DMs without `replyToId` are
 * thread roots in their own right.
 *
 * Cycles are guarded against (a DM whose `replyToId` already appears in the
 * walked chain is treated as a fresh root). This shouldn't happen for rows
 * written via `sendDirectMessage` — it's purely defensive against hand-edited
 * databases.
 */
export function groupDirectMessagesIntoThreads(messages: readonly DirectMessage[]): {
  threadId: string;
  messages: DirectMessage[];
}[] {
  const byId = new Map<string, DirectMessage>();
  for (const msg of messages) {
    byId.set(msg.id, msg);
  }

  const threadRootCache = new Map<string, string>();
  function findRoot(id: string): string {
    const cached = threadRootCache.get(id);
    if (cached) return cached;
    const seen = new Set<string>();
    let cursor = byId.get(id);
    let lastId = id;
    while (cursor && cursor.replyToId && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      lastId = cursor.replyToId;
      cursor = byId.get(cursor.replyToId);
    }
    threadRootCache.set(id, lastId);
    return lastId;
  }

  const grouped = new Map<string, DirectMessage[]>();
  for (const msg of messages) {
    const root = findRoot(msg.id);
    const bucket = grouped.get(root);
    if (bucket) {
      bucket.push(msg);
    } else {
      grouped.set(root, [msg]);
    }
  }

  return [...grouped.entries()]
    .map(([threadId, msgs]) => ({
      threadId,
      messages: msgs.slice().sort((a, b) => a.sentAt.localeCompare(b.sentAt)),
    }))
    .sort((a, b) => {
      const aTs = a.messages[a.messages.length - 1]?.sentAt ?? '';
      const bTs = b.messages[b.messages.length - 1]?.sentAt ?? '';
      return bTs.localeCompare(aTs);
    });
}
