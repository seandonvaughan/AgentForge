/**
 * Central-inbox helpers — adapter-backed, thin, validating layer.
 *
 * v1 hard-limits the recipient set to `['@user']` (see ADR-deferred work in
 * the spec). Multi-recipient + `@team-*` resolution arrives in v2 with no
 * schema change because the junction table is already in place (ADR 0005).
 */

import type { WorkspaceAdapter, InboxMessageRow, InboxRecipientRow } from '@agentforge/db';
import {
  type InboxKind,
  type InboxMessage,
  type InboxRecipient,
  type InboxStatus,
  type SendInboxMessageInput,
  SUPPORTED_INBOX_RECIPIENTS,
  UnsupportedRecipientError,
} from './types.js';

const VALID_KINDS: readonly InboxKind[] = ['info', 'warning', 'action_required'];

function rowToInboxMessage(row: InboxMessageRow): InboxMessage {
  return {
    id: row.id,
    body: row.body,
    kind: row.kind as InboxKind,
    sourceId: row.source_id,
    sourceType: row.source_type,
    threadId: row.thread_id,
    createdAt: row.created_at,
  };
}

function rowToInboxRecipient(row: InboxRecipientRow): InboxRecipient {
  return {
    messageId: row.message_id,
    recipient: row.recipient,
    status: row.status as InboxStatus,
    readAt: row.read_at,
  };
}

export { rowToInboxMessage, rowToInboxRecipient };

/**
 * Persist an inbox message + its recipient rows. Throws when the input
 * violates a v1 invariant — callers should treat each as bad-request.
 */
export function sendInboxMessage(
  adapter: WorkspaceAdapter,
  input: SendInboxMessageInput,
): { message: InboxMessage; recipients: InboxRecipient[] } {
  const body = input.body?.trim();
  if (!body) throw new Error('sendInboxMessage: body is required');
  if (!VALID_KINDS.includes(input.kind)) {
    throw new Error(`sendInboxMessage: kind must be one of ${VALID_KINDS.join(', ')}`);
  }
  if (input.recipients.length === 0) {
    throw new Error('sendInboxMessage: recipients must be non-empty');
  }
  for (const r of input.recipients) {
    if (!SUPPORTED_INBOX_RECIPIENTS.includes(r)) {
      throw new UnsupportedRecipientError(r);
    }
  }

  const { message, recipients } = adapter.createInboxMessage({
    body,
    kind: input.kind,
    ...(input.sourceId !== undefined ? { sourceId: input.sourceId } : {}),
    ...(input.sourceType !== undefined ? { sourceType: input.sourceType } : {}),
    ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
    recipients: input.recipients,
  });

  return {
    message: rowToInboxMessage(message),
    recipients: recipients.map(rowToInboxRecipient),
  };
}

/** Return inbox messages for a recipient, newest first. */
export function listInboxForRecipient(
  adapter: WorkspaceAdapter,
  recipient: string,
  options: {
    status?: InboxStatus | 'all';
    limit?: number;
    offset?: number;
  } = {},
): Array<InboxMessage & { status: InboxStatus; readAt: string | null }> {
  if (!SUPPORTED_INBOX_RECIPIENTS.includes(recipient)) {
    throw new UnsupportedRecipientError(recipient);
  }
  const rows = adapter.listInboxForRecipient({
    recipient,
    status: options.status ?? 'all',
    ...(options.limit !== undefined ? { limit: options.limit } : {}),
    ...(options.offset !== undefined ? { offset: options.offset } : {}),
  });
  return rows.map((row) => ({
    ...rowToInboxMessage(row),
    status: row.status as InboxStatus,
    readAt: row.read_at,
  }));
}

export function getInboxMessage(
  adapter: WorkspaceAdapter,
  id: string,
): { message: InboxMessage; recipients: InboxRecipient[] } | undefined {
  const row = adapter.getInboxMessage(id);
  if (!row) return undefined;
  const recipients = adapter.listInboxRecipients(id);
  return {
    message: rowToInboxMessage(row),
    recipients: recipients.map(rowToInboxRecipient),
  };
}

export function markInboxRead(
  adapter: WorkspaceAdapter,
  id: string,
  recipient: string,
): InboxRecipient | undefined {
  if (!SUPPORTED_INBOX_RECIPIENTS.includes(recipient)) {
    throw new UnsupportedRecipientError(recipient);
  }
  const row = adapter.markInboxRead(id, recipient);
  return row ? rowToInboxRecipient(row) : undefined;
}

export function countUnread(adapter: WorkspaceAdapter, recipient: string): number {
  return adapter.countInboxForRecipient(recipient, 'unread');
}
