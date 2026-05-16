/**
 * Public types for the v1 agent communication layer.
 *
 * Two surfaces:
 *
 *   1. Direct messages — peer-to-peer between agents, delivered via prompt
 *      injection (see `injectAgentDms`). Backed by `direct_messages` in the
 *      workspace DB.
 *   2. Central inbox — durable, queryable, recipient-state-tracked messages.
 *      v1 only supports `@user` recipient; `@team-*` resolution deferred.
 *
 * See `docs/v2-architecture/agent-comm-and-kb-spec.md` and ADRs 0001 + 0005.
 */

export type InboxKind = 'info' | 'warning' | 'action_required';
export type InboxStatus = 'unread' | 'read' | 'archived';

/** Single-recipient direct message (peer-to-peer). */
export interface DirectMessage {
  id: string;
  fromAgent: string;
  toAgent: string;
  body: string;
  replyToId: string | null;
  sentAt: string;
  deliveredAt: string | null;
}

/** Central-inbox message (one body, fan-out to recipients via junction table). */
export interface InboxMessage {
  id: string;
  body: string;
  kind: InboxKind;
  sourceId: string | null;
  sourceType: string | null;
  threadId: string | null;
  createdAt: string;
}

/** Per-recipient status row for an inbox message. */
export interface InboxRecipient {
  messageId: string;
  recipient: string;
  status: InboxStatus;
  readAt: string | null;
}

/** v1 inbox helper input — recipients is enforced to `['@user']` upstream. */
export interface SendInboxMessageInput {
  body: string;
  kind: InboxKind;
  sourceId?: string;
  sourceType?: string;
  threadId?: string;
  /** v1: must be `['@user']`. Future versions accept `@team-*` etc. */
  recipients: readonly string[];
}

export interface SendDirectMessageInput {
  from: string;
  to: string;
  body: string;
  /** Optional parent DM id for threading — must reference an existing row. */
  replyToId?: string;
}

/**
 * v1 only supports the literal `@user` recipient. Helpers and routes throw
 * a `UnsupportedRecipientError` when given anything else. Lifting this lets
 * v2 add `@team-*` resolution without changing call sites that already
 * targeted `@user`.
 */
export const SUPPORTED_INBOX_RECIPIENTS: readonly string[] = ['@user'];

export class UnsupportedRecipientError extends Error {
  constructor(recipient: string) {
    super(
      `Recipient "${recipient}" is not supported in v1. ` +
        `Only ${SUPPORTED_INBOX_RECIPIENTS.join(', ')} is accepted; ` +
        `multi-recipient + @team-* resolution arrives in v2.`,
    );
    this.name = 'UnsupportedRecipientError';
  }
}
