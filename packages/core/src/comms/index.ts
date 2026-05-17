/**
 * Agent communication primitives (v1).
 *
 * - `sendDirectMessage` / `injectAgentDms` — peer-to-peer DMs, delivered via
 *   prompt injection (ADR 0001).
 * - `sendInboxMessage` / `listInboxForRecipient` — durable inbox addressed to
 *   `@user` (v1 limit per the spec's "v1 minimum viable" section).
 * - `InboxBridge` — daemon that mirrors selected `MessageBusV2` events into
 *   the inbox.
 *
 * See `docs/v2-architecture/agent-comm-and-kb-spec.md` + ADRs 0001–0005.
 */

export * from './types.js';
export {
  sendDirectMessage,
  listDirectMessagesForAgent,
  groupDirectMessagesIntoThreads,
  rowToDirectMessage,
} from './direct-messages.js';
export {
  sendInboxMessage,
  listInboxForRecipient,
  getInboxMessage,
  markInboxRead,
  countUnread,
  rowToInboxMessage,
  rowToInboxRecipient,
} from './inbox.js';
export {
  injectAgentDms,
  buildAgentDmsBlock,
  type InjectAgentDmsOptions,
} from './inject-agent-dms.js';
export { InboxBridge, type InboxBridgeOptions } from './inbox-bridge.js';
export {
  createKb,
  listKbs,
  getKb,
  getKbBySlug,
  updateKb,
  deleteKb,
  createKbDoc,
  listKbDocs,
  getKbDoc,
  updateKbDoc,
  getKbDocVersionHistory,
  getKbDocAtVersion,
  rowToKb,
  rowToKbDoc,
  rowToKbDocVersion,
  type Kb,
  type KbDoc,
  type KbDocVersion,
  type KbDocWithBody,
  type KbVisibility,
  type CreateKbInput,
  type UpdateKbInput,
  type CreateKbDocInput,
  type UpdateKbDocInput,
} from './kbs.js';
export {
  resolveTeamRecipients,
  clearTeamRecipientsCache,
} from './team-recipients.js';
export {
  buildCcDmDirectiveBlock,
  type BuildCcDmDirectiveBlockOptions,
} from './cc-dm-bridge.js';
export {
  buildCcInboxBriefing,
  type BuildCcInboxBriefingOptions,
} from './cc-inbox-bridge.js';
