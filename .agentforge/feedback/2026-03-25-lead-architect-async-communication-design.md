---
id: f7a3c8d1-2e94-4b61-a5f7-8c0d3e9b2a47
agent: lead-architect
category: feature
priority: critical
timestamp: "2026-03-25T10:00:00.000Z"
---

# Async Agent Communication System: Design Proposal

## Problem

The current v2 communication stack requires that any meaningful agent-to-agent exchange incurs an LLM invocation. A Haiku QA agent that needs to flag an issue to the CTO must go through the orchestrator's delegation chain, which means:

1. The Haiku agent's output is escalated to a Sonnet team lead.
2. The team lead must decide whether to escalate further.
3. Reaching the CTO (Opus) costs ~10-20x a Haiku invocation even if the CTO ultimately just reads a one-paragraph summary and says "noted."

This is the core waste pattern documented in `project_dogfood_audit.md`: Opus tokens spent on context that lower-tier agents could have resolved or pre-digested without any model invocation at all.

The proposed solution: a **file-system-native async communication layer** where agents write messages as markdown files. Agents read their inbox when they're next invoked — no model invocations are triggered by the act of writing or routing messages. The entire communication system runs at zero model cost.

This system is additive to — not a replacement for — the `MessageBus`, `HandoffManager`, and `EventBus` proposed in `2026-03-25-integration-architecture-lead-v3-synthesis.md`. Those components handle in-process synchronous coordination during active orchestrator sessions. The async layer handles durable, cross-invocation, low-cost communication.

---

## Architecture Overview

### The Two Communication Layers

```
LAYER 1: In-Process (existing v2 + v3 additions)
  EventBus → MessageBus → HandoffManager → ContextManager
  Cost: model invocations (Haiku/Sonnet/Opus)
  Use: active orchestrator sessions, real-time coordination, delegation

LAYER 2: File-System Async (NEW — this proposal)
  DMs → Channels → Inbox
  Cost: ZERO (file reads/writes only)
  Use: cross-invocation coordination, team broadcasts, pre-digested briefings
```

The key insight: Layer 2 acts as a **holding buffer** between invocations. Work is done, questions are resolved, and context is pre-digested in Layer 2 before any model is invoked. When a model IS invoked, it reads a clean, structured inbox rather than being handed raw problems.

---

## 1. Directory Structure

```
.agentforge/
  messages/                          # Direct agent-to-agent messages (DMs)
    {recipient-agent}/
      {timestamp}-{sender}-{id}.md  # One file per message

  channels/                          # Team broadcast channels
    core-platform/
      {timestamp}-{author}-{id}.md  # One post per file
    runtime/
    experience/
    rd-updates/
    qa-reports/
    executive-decisions/
    all-hands/

  inbox/                             # Email-like structured inbox
    {agent-name}/
      {timestamp}-{sender}-{id}.md  # One message per file (YAML frontmatter)
      threads/
        {thread-id}/
          {timestamp}-{agent}-{n}.md  # Ordered replies in a thread

  inbox/.meta/                       # Inbox metadata (fast status checks)
    {agent-name}/
      unread.json                    # List of unread message IDs + counts
      last-checked.txt               # ISO timestamp of last inbox check
```

### Naming conventions

Message files use the pattern `{ISO-timestamp}-{sender-slug}-{8-char-id}.md` so that:
- Directory listings are chronologically sorted without reading file contents
- The sender is visible without opening the file
- IDs are short enough to use in thread references but unique enough to avoid collisions

Example: `2026-03-25T09:32:00Z-qa-lead-a3f8d1c2.md`

---

## 2. TypeScript Interfaces

### 2.1 Direct Messages

```typescript
// src/types/async-communication.ts — NEW FILE

import type { MessagePriority } from "./message.js";

/**
 * A direct agent-to-agent message.
 *
 * Written as a markdown file to .agentforge/messages/{recipient}/
 * Read by the recipient at the start of their next invocation.
 * Zero model cost to send or route.
 */
export interface DirectMessage {
  /** Unique message ID (8-char hex). */
  id: string;
  /** Sending agent's slug name (e.g. "qa-lead", "haiku-scanner"). */
  sender: string;
  /** Recipient agent's slug name. */
  recipient: string;
  /** ISO-8601 timestamp when the message was written. */
  timestamp: string;
  /** One-line subject. Used for inbox previews without reading body. */
  subject: string;
  /** Markdown body. Supports structured content, code blocks, lists. */
  body: string;
  /** Message urgency. Default: "normal". */
  priority: MessagePriority;
  /**
   * Whether the sender is waiting for a response before proceeding.
   * When true, the recipient should reply via their inbox.
   * When false, this is informational — no reply expected.
   */
  requires_response: boolean;
  /**
   * If this is a reply, the thread_id of the conversation it belongs to.
   * If null, this starts a new thread.
   */
  thread_id: string | null;
}
```

### 2.2 Channel Posts

```typescript
/**
 * Valid async communication channel names.
 *
 * Maps to directory names under .agentforge/channels/
 */
export type ChannelName =
  | "core-platform"
  | "runtime"
  | "experience"
  | "rd-updates"
  | "qa-reports"
  | "executive-decisions"
  | "all-hands";

/**
 * A post to a team broadcast channel.
 *
 * Written to .agentforge/channels/{channel-name}/
 * Any agent subscribed to the channel reads it at next invocation.
 * No response mechanism — use DirectMessage or Inbox for replies.
 */
export interface ChannelPost {
  /** Unique post ID. */
  id: string;
  /** Agent that wrote the post. */
  author: string;
  /** Target channel. */
  channel: ChannelName;
  /** ISO-8601 timestamp. */
  timestamp: string;
  /** Post title / headline. */
  title: string;
  /** Markdown body. */
  body: string;
  /** Optional tags for filtering (e.g. ["breaking-change", "needs-review"]). */
  tags: string[];
  /** Priority. High-priority posts appear first in channel digests. */
  priority: MessagePriority;
}

/**
 * Per-agent channel subscription registry.
 *
 * Stored in .agentforge/channels/.subscriptions/{agent-name}.json
 * Determines which channels the agent reads at invocation time.
 */
export interface ChannelSubscription {
  agentName: string;
  channels: ChannelName[];
  /** ISO timestamp of last read for each channel — drives unread counts. */
  lastRead: Partial<Record<ChannelName, string>>;
}
```

### 2.3 Inbox Messages and Threads

```typescript
/** Status lifecycle for an inbox message. */
export type InboxMessageStatus = "unread" | "read" | "actioned" | "forwarded";

/**
 * A structured inbox message with full YAML frontmatter.
 *
 * The primary mechanism for teams to work things out BEFORE
 * escalating to Opus executives. An agent receiving an inbox
 * message at invocation time processes it as part of their task
 * context — no separate model call required.
 */
export interface InboxMessage {
  /** Unique message ID. Used as thread_id for new conversations. */
  id: string;
  /** Sender agent slug. */
  from: string;
  /** Recipient agent slug. */
  to: string;
  /** One-line subject. */
  subject: string;
  /** Current read/action status. */
  status: InboxMessageStatus;
  /**
   * Thread this message belongs to.
   * For the first message in a conversation, thread_id === id.
   * Replies set thread_id to the original message's id.
   */
  thread_id: string;
  /**
   * Sequential message number within the thread (1-indexed).
   * Used to order replies without relying on filesystem timestamps.
   */
  sequence: number;
  /** Message priority. */
  priority: MessagePriority;
  /** ISO-8601 timestamp. */
  timestamp: string;
  /**
   * Whether this message requires a decision or action from the recipient
   * before the sender can proceed. Used to detect blocking dependencies.
   */
  action_required: boolean;
  /**
   * If action_required, what the sender needs:
   * - "decision": pick between options
   * - "review": approve or request changes
   * - "answer": respond to a question
   * - "acknowledgement": just confirm receipt
   */
  action_type?: "decision" | "review" | "answer" | "acknowledgement";
  /** Deadline for action, if any. ISO-8601. */
  action_deadline?: string;
  /** Markdown body. */
  body: string;
  /**
   * Structured options for decision-type messages.
   * The recipient selects one when replying.
   */
  options?: Array<{
    id: string;
    label: string;
    description: string;
    cost_impact?: string;
  }>;
}

/**
 * A reply within an existing thread.
 *
 * Written to .agentforge/inbox/{agent}/threads/{thread_id}/
 * Extends InboxMessage but always has sequence > 1.
 */
export type ThreadReply = InboxMessage & {
  thread_id: string;       // always set (same as original message id)
  sequence: number;        // 2, 3, 4...
  in_reply_to: string;     // id of the message being replied to
  selected_option?: string; // for decision replies: which option was chosen
};

/**
 * A complete thread: the root message plus all replies in sequence order.
 */
export interface MessageThread {
  thread_id: string;
  participants: string[];
  subject: string;
  messages: InboxMessage[];  // sorted by sequence ascending
  /** True when the thread has been closed (decision made, no further replies expected). */
  closed: boolean;
  /** The final decision reached, if any. */
  resolution?: string;
}

/**
 * Inbox metadata for fast unread-count checks.
 *
 * Written to .agentforge/inbox/.meta/{agent-name}/unread.json
 * Updated on every write to the inbox, read before every invocation.
 */
export interface InboxMeta {
  agentName: string;
  unreadCount: number;
  actionRequiredCount: number;
  /** IDs of unread messages sorted by priority then timestamp. */
  unreadIds: string[];
  lastUpdated: string;
}
```

---

## 3. Integration with Existing EventBus and HandoffManager

The async layer integrates at two seams in the existing architecture:

### 3.1 HandoffManager writes to Inbox on completion

When `HandoffManager.createHandoff()` completes, it currently (in the proposed v3 update) enqueues a `handoff_complete` event on the `MessageBus`. In addition, it should write an inbox message to the recipient agent:

```typescript
// Additive change to HandoffManager.createHandoff()
// Writes an inbox message so the recipient sees handoff context
// at their NEXT invocation, even if the MessageBus is not active.

if (this.asyncMessenger) {
  await this.asyncMessenger.writeInbox({
    id: randomUUID(),
    from: from,
    to: to,
    subject: `Handoff: ${artifact.type} — ${artifact.summary}`,
    status: "unread",
    thread_id: handoffId,
    sequence: 1,
    priority: "high",
    timestamp: new Date().toISOString(),
    action_required: openQuestions.length > 0,
    action_type: openQuestions.length > 0 ? "review" : "acknowledgement",
    body: this.buildHandoffContext(handoff, to),
  });
}
```

The `AsyncMessenger` (see section 5) is optional — if not injected, the HandoffManager falls back to the existing in-process behavior. No breaking changes.

### 3.2 EventBus publishes bridge async channel posts

When the `MessageBus` dispatches a `security_alert` or `architecture_decision` event, it should simultaneously write to the appropriate channel so agents that are NOT currently active can read the update at their next invocation:

```typescript
// In MessageBus.flush(), after dispatching handlers:
if (this.asyncMessenger && CHANNEL_BRIDGED_EVENTS.has(enqueued.event.type)) {
  await this.asyncMessenger.writeChannel(
    EVENT_TO_CHANNEL_MAP[enqueued.event.type],
    {
      id: randomUUID(),
      author: enqueued.event.source,
      channel: EVENT_TO_CHANNEL_MAP[enqueued.event.type],
      timestamp: new Date().toISOString(),
      title: `[${enqueued.event.type}] ${enqueued.event.source}`,
      body: formatEventAsMarkdown(enqueued),
      tags: [enqueued.event.type],
      priority: enqueued.priority,
    }
  );
}

const EVENT_TO_CHANNEL_MAP: Record<string, ChannelName> = {
  security_alert:         "core-platform",
  architecture_decision:  "executive-decisions",
  handoff_complete:       "core-platform",
  integration_action:     "rd-updates",
  agent_error:            "qa-reports",
};
```

### 3.3 ContextManager injects inbox at task assembly time

When `ContextManager.assembleTaskContext()` builds context for an agent invocation, it should include the agent's unread inbox messages as a section:

```typescript
// Additive change to assembleTaskContext()
if (this.asyncMessenger) {
  const inbox = await this.asyncMessenger.readInbox(agent.name, {
    status: ["unread"],
    limit: 10,
    sortBy: "priority",
  });
  if (inbox.length > 0) {
    sections.push("\n## Inbox (Unread Messages)\n");
    sections.push(formatInboxForContext(inbox));
  }
}
```

This means inbox messages are part of the agent's task context — not a separate invocation. A Haiku QA agent wakes up, sees their inbox as part of their task context, processes messages, and continues with their assigned work. No extra model calls.

---

## 4. The AsyncMessenger Service

All file-system reads and writes are encapsulated in a single service:

```typescript
// src/orchestrator/async-messenger.ts — NEW FILE

import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
  DirectMessage,
  ChannelPost,
  ChannelName,
  ChannelSubscription,
  InboxMessage,
  InboxMeta,
  MessageThread,
  ThreadReply,
} from "../types/async-communication.js";

/**
 * File-system-native async messaging layer for AgentForge v3.
 *
 * Writes and reads markdown files with YAML frontmatter.
 * Zero model cost — all operations are pure file I/O.
 *
 * Integrated into AgentForgeSession as an optional component.
 * When present, HandoffManager and MessageBus write to it automatically.
 * When absent (e.g. in tests), in-process messaging continues as before.
 */
export class AsyncMessenger {
  private readonly root: string;

  constructor(agentforgeRoot: string) {
    // e.g. /path/to/project/.agentforge
    this.root = agentforgeRoot;
  }

  // --- Direct Messages ---

  async writeDM(message: DirectMessage): Promise<string> {
    const dir = path.join(this.root, "messages", message.recipient);
    await fs.mkdir(dir, { recursive: true });
    const filename = `${toFilesafeTimestamp(message.timestamp)}-${message.sender}-${message.id}.md`;
    const content = renderDirectMessage(message);
    await fs.writeFile(path.join(dir, filename), content, "utf-8");
    return filename;
  }

  async readDMs(agentName: string): Promise<DirectMessage[]> {
    const dir = path.join(this.root, "messages", agentName);
    const files = await listMarkdownFiles(dir);
    return Promise.all(files.map((f) => parseDirectMessage(path.join(dir, f))));
  }

  // --- Channels ---

  async writeChannel(channel: ChannelName, post: ChannelPost): Promise<string> {
    const dir = path.join(this.root, "channels", channel);
    await fs.mkdir(dir, { recursive: true });
    const filename = `${toFilesafeTimestamp(post.timestamp)}-${post.author}-${post.id}.md`;
    await fs.writeFile(path.join(dir, filename), renderChannelPost(post), "utf-8");
    return filename;
  }

  async readChannel(
    channel: ChannelName,
    since?: string,
  ): Promise<ChannelPost[]> {
    const dir = path.join(this.root, "channels", channel);
    const files = await listMarkdownFiles(dir);
    const posts = await Promise.all(
      files.map((f) => parseChannelPost(path.join(dir, f)))
    );
    return since
      ? posts.filter((p) => p.timestamp > since)
      : posts;
  }

  async getChannelDigest(agentName: string): Promise<ChannelPost[]> {
    const sub = await this.loadSubscription(agentName);
    const results: ChannelPost[] = [];
    for (const channel of sub.channels) {
      const lastRead = sub.lastRead[channel];
      const posts = await this.readChannel(channel, lastRead);
      results.push(...posts);
    }
    return results.sort(byPriorityThenTimestamp);
  }

  // --- Inbox ---

  async writeInbox(message: InboxMessage): Promise<string> {
    const dir = message.thread_id === message.id
      ? path.join(this.root, "inbox", message.to)
      : path.join(this.root, "inbox", message.to, "threads", message.thread_id);
    await fs.mkdir(dir, { recursive: true });
    const filename = `${toFilesafeTimestamp(message.timestamp)}-${message.from}-${message.id}.md`;
    await fs.writeFile(path.join(dir, filename), renderInboxMessage(message), "utf-8");
    await this.updateInboxMeta(message.to, message);
    return filename;
  }

  async readInbox(
    agentName: string,
    options?: { status?: InboxMessage["status"][]; limit?: number; sortBy?: "priority" | "timestamp" }
  ): Promise<InboxMessage[]> {
    const dir = path.join(this.root, "inbox", agentName);
    const files = await listMarkdownFiles(dir);
    const messages = await Promise.all(
      files.map((f) => parseInboxMessage(path.join(dir, f)))
    );
    let filtered = options?.status
      ? messages.filter((m) => options.status!.includes(m.status))
      : messages;
    if (options?.sortBy === "priority") {
      filtered = filtered.sort(byPriorityThenTimestamp);
    }
    return options?.limit ? filtered.slice(0, options.limit) : filtered;
  }

  async markRead(agentName: string, messageId: string): Promise<void> {
    // Updates the status field in the message file's frontmatter and
    // decrements the unread counter in .meta/unread.json
    await this.updateMessageStatus(agentName, messageId, "read");
  }

  async markActioned(agentName: string, messageId: string): Promise<void> {
    await this.updateMessageStatus(agentName, messageId, "actioned");
  }

  async reply(
    originalMessage: InboxMessage,
    replyBody: string,
    from: string,
    selectedOption?: string,
  ): Promise<ThreadReply> {
    const thread = await this.getThread(originalMessage.to, originalMessage.thread_id);
    const reply: ThreadReply = {
      id: randomUUID().slice(0, 8),
      from,
      to: originalMessage.from,     // reply goes back to sender
      subject: `Re: ${originalMessage.subject}`,
      status: "unread",
      thread_id: originalMessage.thread_id,
      sequence: thread.messages.length + 1,
      priority: originalMessage.priority,
      timestamp: new Date().toISOString(),
      action_required: false,
      body: replyBody,
      in_reply_to: originalMessage.id,
      selected_option: selectedOption,
    };
    await this.writeInbox(reply as InboxMessage);
    return reply;
  }

  async getThread(agentName: string, threadId: string): Promise<MessageThread> {
    const threadDir = path.join(
      this.root, "inbox", agentName, "threads", threadId
    );
    const files = await listMarkdownFiles(threadDir);
    const messages = await Promise.all(
      files.map((f) => parseInboxMessage(path.join(threadDir, f)))
    );
    const sorted = messages.sort((a, b) => a.sequence - b.sequence);
    return {
      thread_id: threadId,
      participants: [...new Set(sorted.flatMap((m) => [m.from, m.to]))],
      subject: sorted[0]?.subject ?? "(no subject)",
      messages: sorted,
      closed: sorted.some((m) => "selected_option" in m && m.selected_option),
      resolution: (sorted.findLast((m) => "selected_option" in m) as ThreadReply)
        ?.selected_option,
    };
  }

  // --- Internal helpers ---

  private async loadSubscription(agentName: string): Promise<ChannelSubscription> {
    const subPath = path.join(
      this.root, "channels", ".subscriptions", `${agentName}.json`
    );
    try {
      const raw = await fs.readFile(subPath, "utf-8");
      return JSON.parse(raw) as ChannelSubscription;
    } catch {
      return { agentName, channels: [], lastRead: {} };
    }
  }

  private async updateInboxMeta(agentName: string, message: InboxMessage): Promise<void> {
    const metaDir = path.join(this.root, "inbox", ".meta", agentName);
    await fs.mkdir(metaDir, { recursive: true });
    const metaPath = path.join(metaDir, "unread.json");
    let meta: InboxMeta;
    try {
      meta = JSON.parse(await fs.readFile(metaPath, "utf-8")) as InboxMeta;
    } catch {
      meta = { agentName, unreadCount: 0, actionRequiredCount: 0, unreadIds: [], lastUpdated: "" };
    }
    meta.unreadCount += 1;
    if (message.action_required) meta.actionRequiredCount += 1;
    meta.unreadIds.push(message.id);
    meta.lastUpdated = new Date().toISOString();
    await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), "utf-8");
  }

  private async updateMessageStatus(
    agentName: string,
    messageId: string,
    newStatus: InboxMessage["status"],
  ): Promise<void> {
    // Implementation: scan inbox dir, find file by id in frontmatter, rewrite status field
    // Omitted for brevity — uses regex replace on frontmatter YAML
  }
}
```

### Markdown file format

All messages are stored as Markdown with YAML frontmatter for structured metadata and human-readable body:

```markdown
---
id: a3f8d1c2
from: qa-lead
to: core-platform-lead
subject: "Test failures in async-messenger — 3 edge cases need clarification"
status: unread
thread_id: a3f8d1c2
sequence: 1
priority: high
timestamp: "2026-03-25T09:32:00.000Z"
action_required: true
action_type: answer
---

## Context

Running the async-messenger test suite against the new `writeInbox()` implementation.
Three edge cases are failing and I need clarification before I can fix them.

## Issues

1. **Thread directory creation race condition**: When two agents reply to the same thread
   simultaneously, `fs.mkdir` fails with EEXIST. Should we use `{ recursive: true }` or
   serialize with a lock file?

2. **Frontmatter encoding**: Message subjects with colons break YAML parsing.
   Proposing we always quote the subject field. Confirm?

3. **Meta update atomicity**: `updateInboxMeta()` is not atomic. Under concurrent writes,
   the `unreadCount` can be incorrect. Suggest using an append-only array and computing
   count on read rather than maintaining a counter. Agree?

## Request

Please answer these three questions so I can ship the final test suite.
No need to escalate to Opus — this is a straightforward implementation decision.
```

---

## 5. Escalation Protocol: How Teams Prepare Briefings for Executives

This is the central cost-control mechanism. The rule is explicit: **the CTO's inbox should never contain raw problems**. It should contain pre-digested briefings with a recommended option already selected by the team.

### The escalation chain

```
Level 0: Individual contributors (Haiku)
  → Resolve via DMs with peers
  → Post to team channel if broader awareness needed
  → If blocked: write to team lead's inbox

Level 1: Team leads (Sonnet)
  → Read team inbox at invocation start
  → Resolve intra-team questions via inbox threads
  → Consult peer leads via DMs for cross-team questions
  → Post conclusions to relevant channels (#core-platform, #runtime, etc.)
  → If cross-team dispute unresolved: write to VP Engineering inbox
    with: problem summary, options considered, recommended option, cost impact

Level 2: VP Engineering (Sonnet)
  → Reads lead escalations
  → Arbitrates cross-team disputes by reviewing team threads
  → If project-wide strategic decision needed: writes to CTO inbox
    with: 1-paragraph executive summary, recommended decision, cost impact, confidence

Level 3: CTO (Opus)
  → Reads only executive-summary briefings
  → CTO inbox ONLY receives messages from VP Engineering or Lead Architect
  → Messages to CTO inbox must include:
      - executive_summary (≤150 words)
      - recommended_decision (single sentence)
      - cost_impact (e.g. "+2% Opus budget for 3 sessions")
      - confidence (the recommender's confidence in their recommendation, 0-1)
      - thread_id linking to the full deliberation chain
  → CTO selects an option or issues a directive
  → Decision written to #executive-decisions channel automatically
```

### The Briefing Message Schema

Messages sent to the `cto` or `vp-engineering` inboxes must conform to an extended schema:

```typescript
export interface ExecutiveBriefing extends InboxMessage {
  action_required: true;
  action_type: "decision";
  /** Required for executive inbox messages. */
  executive_summary: string;     // ≤ 150 words
  recommended_option: string;    // option id from options[] array
  cost_impact: string;           // human-readable cost assessment
  confidence: number;            // recommender's confidence (0–1)
  /** Link to the full thread where teams deliberated. */
  deliberation_thread_id: string;
  /** Names of agents who participated in the deliberation. */
  deliberation_participants: string[];
}
```

### Inbox context injection for executives

When `ContextManager.assembleTaskContext()` runs for the CTO agent, the inbox section renders only the executive summary and recommended option — not the full body:

```
## Inbox (1 unread — action required)

### [HIGH] Cross-domain API versioning decision
From: vp-engineering | Thread: b8f2a3d1
Summary: Core Platform and Runtime disagree on whether to version the builder API
  at the URL level (Runtime's position) or via Accept headers (Core Platform's position).
  Both approaches are technically valid. URL versioning is simpler to implement (+0 cost).
  Header versioning aligns with REST best practices but adds complexity (+0.5 dev-days).
Recommendation: URL versioning (option A)
Cost impact: Neutral
Confidence: 0.87
→ Full deliberation: .agentforge/inbox/cto/threads/b8f2a3d1/
```

The CTO reads a clean, scannable briefing. If they agree with the recommendation, they reply with `selected_option: "A"`. If they want to read the full thread, the path is right there. At no point were Opus tokens spent on the Haiku QA agent's raw edge case questions.

---

## 6. Cost Impact

### Current waste pattern (v2)

In v2, any cross-agent question requires:
1. Agent A is invoked (model call 1) and produces a question.
2. Orchestrator routes to Agent B (in-process, free).
3. Agent B is invoked (model call 2) to answer.
4. If escalation needed: Agent C (Sonnet team lead) is invoked (model call 3).
5. If still unresolved: Agent D (CTO, Opus) is invoked (model call 4).

A single QA question from a Haiku agent can chain into an Opus invocation in 4 steps if the routing logic doesn't stop it.

### With async communication layer

1. Agent A writes an inbox message (0 model calls).
2. Agent B reads it at their next scheduled invocation — a call they were going to make anyway (existing model call, inbox is just context).
3. Agent B replies (0 additional model calls — reply is part of their existing invocation output).
4. If escalation needed: only after the full team thread is resolved does a briefing reach the team lead's inbox. No extra invocations triggered.

### Quantified reduction

Based on the v2 dogfood audit findings:

| Scenario | v2 invocations | v3 async invocations | Reduction |
|---|---|---|---|
| Haiku asks Haiku a question | 2 | 0 extra (absorbed into scheduled runs) | ~100% |
| QA issue → team lead | 3 | 0 extra | ~100% |
| Cross-team dispute → VP Engineering | 4–5 | 0–1 extra (one VP invocation to arbitrate) | ~75–80% |
| Strategic decision → CTO | 5–6 | 1 (CTO reads briefing, not raw context) | ~80–85% |

The system does not eliminate Opus invocations — it ensures that when Opus is invoked, the context it receives is maximally pre-digested. The CTO reads a 150-word executive summary, not a 12,000-token chain of raw agent outputs.

**Projected impact**: If the current Opus allocation is 7% of token budget and 60% of those tokens are spent on escalations that could have been resolved at Haiku/Sonnet level, reducing unnecessary escalations by 80% would bring effective Opus spend from 7% to ~4.2% of total budget — a 40% cost reduction while maintaining the same decision quality.

---

## 7. Example Workflows

### Workflow A: Haiku-to-Haiku Question (Zero extra model calls)

```
1. haiku-test-runner completes test suite, finds 3 flaky tests.
   → Writes DM to haiku-fixture-builder:
     .agentforge/messages/haiku-fixture-builder/
       2026-03-25T09:32:00Z-haiku-test-runner-a3f8d1c2.md
     Subject: "3 flaky tests in fixture teardown — are shared fixtures being reset?"
     requires_response: true

2. haiku-fixture-builder is invoked for its next scheduled task.
   → ContextManager reads its DMs as part of assembleTaskContext().
   → DM appears in context: "You have 1 unread DM from haiku-test-runner."
   → haiku-fixture-builder answers the question AS PART OF ITS CURRENT INVOCATION.
   → Writes reply DM to haiku-test-runner.
   → Zero extra model calls triggered.

3. haiku-test-runner reads reply in its next invocation.
   → Issue resolved entirely within Haiku tier.
```

### Workflow B: Team Broadcast via Channel

```
1. build-release-lead (Sonnet) completes a breaking API change.
   → Writes to #core-platform channel:
     .agentforge/channels/core-platform/
       2026-03-25T10:15:00Z-build-release-lead-c7b2e4f1.md
     Title: "[BREAKING] builder-api v2.1: removed deprecated `forge()` overload"
     tags: ["breaking-change", "builder-api"]
     priority: high

2. All agents subscribed to #core-platform see this post at their next invocation.
   → ContextManager.assembleTaskContext() includes channel digest.
   → No agent needs to be explicitly notified; no orchestrator routing needed.
   → Agents that don't need this context aren't subscribed and see nothing.

3. If a team lead needs to act on this, they write to their team's inbox.
   → No Opus tokens involved at any point.
```

### Workflow C: Cross-Team Dispute Resolved Before CTO Invocation

```
1. core-platform-lead (Sonnet) and runtime-platform-lead (Sonnet) disagree
   on API versioning strategy.

2. core-platform-lead opens a thread:
   → Writes to runtime-platform-lead's inbox:
     Subject: "API versioning: URL vs header — need to align before v3 RC"
     action_required: true, action_type: decision
     options: [{id: "A", label: "URL versioning"}, {id: "B", label: "Header versioning"}]

3. runtime-platform-lead reads inbox at next invocation.
   → Replies with arguments for header versioning.
   → 2 more exchanges in thread.

4. Thread stalls — neither lead will concede.
   → runtime-platform-lead writes to vp-engineering inbox:
     ExecutiveBriefing with:
       executive_summary: "Core and Runtime disagree on versioning..."
       recommended_option: "A"  (URL versioning, simpler)
       cost_impact: "Neutral"
       confidence: 0.72
       deliberation_thread_id: "b8f2a3d1"

5. vp-engineering (Sonnet) reads briefing at next invocation.
   → Reviews deliberation thread (no extra invocation — just file reads).
   → Selects option A, writes decision to #executive-decisions channel.
   → Posts decision to both teams' inboxes.

6. CTO is NOT invoked. This was a cross-team dispute, not a strategic question.
   → Opus saved entirely.

7. IF vp-engineering cannot decide: escalates to CTO with 150-word briefing.
   → CTO reads 150 words, selects option. 1 Opus invocation, minimal tokens.
```

### Workflow D: Executive Briefing Delivered Pre-Digested

```
1. Three research teams (rd-updates) have completed cost analysis.
   → Each posts findings to #rd-updates channel.
   → cost-optimization-lead (Sonnet) reads channel digest at invocation.

2. cost-optimization-lead synthesizes findings.
   → Writes to lead-architect inbox:
     Subject: "Cost optimization synthesis — recommend adopting dynamic routing"
     executive_summary: "Three research tracks converge on dynamic model routing
       as highest-ROI v3 investment. Haiku-first routing with Sonnet escalation
       reduces projected Opus spend from 15% to 7% of token budget. All three
       research leads recommend this approach. Full analysis in thread."
     recommended_option: "dynamic-routing"
     cost_impact: "-8% Opus allocation, -~$400/month at current usage"
     confidence: 0.91
     deliberation_thread_id: "e2c9a7f3"

3. lead-architect reads briefing at next invocation.
   → Agrees. Writes architecture decision to #executive-decisions.
   → Posts brief update to CTO inbox (notification, not decision request):
     "Dynamic model routing approved by lead-architect. Posting for awareness.
      No decision required."

4. CTO reads 2-sentence notification.
   → No decision needed. Acknowledged as part of normal invocation.
   → Total Opus tokens: ~50 for acknowledgement vs. ~2,000 if raw research
     had been passed directly.
```

---

## 8. Implementation Plan

This system is entirely additive. Nothing in the existing codebase is modified; new components are opt-in via `AgentForgeSession` configuration.

### New files

```
src/
  types/
    async-communication.ts          # DirectMessage, ChannelPost, InboxMessage,
                                     # ThreadReply, MessageThread, InboxMeta,
                                     # ChannelSubscription, ExecutiveBriefing
  orchestrator/
    async-messenger.ts              # AsyncMessenger service (file I/O)
    inbox-formatter.ts              # formatInboxForContext(), renderInboxMessage()
    channel-formatter.ts            # renderChannelPost(), formatChannelDigest()
.agentforge/
  channels/
    .subscriptions/                  # Per-agent channel subscription JSON files
    core-platform/                   # (initially empty)
    runtime/
    experience/
    rd-updates/
    qa-reports/
    executive-decisions/
    all-hands/
  messages/                          # (initially empty, created on first DM)
  inbox/
    .meta/                           # (initially empty)
```

### Changes to existing files

| File | Change | Risk |
|---|---|---|
| `src/orchestrator/session.ts` | Add optional `asyncMessenger?: AsyncMessenger` to `SessionConfig` and `AgentForgeSession` | Low — optional field |
| `src/orchestrator/handoff-manager.ts` | Add optional `asyncMessenger` param; call `writeInbox()` on handoff creation | Low — optional, no behavior change if absent |
| `src/orchestrator/message-bus.ts` | Add optional channel-bridging for `security_alert`, `architecture_decision` | Low — optional |
| `src/orchestrator/context-manager.ts` | Add async inbox/channel digest to `assembleTaskContext()` | Low — additive section |
| `.agentforge/agents/{lead}.yaml` | Add `channel_subscriptions` field to agent YAML | Non-breaking — new optional field |

### Milestone sequencing

**Milestone A (1–2 days): Types and AsyncMessenger**
- `src/types/async-communication.ts`
- `src/orchestrator/async-messenger.ts` with full read/write/thread support
- Unit tests for all file I/O paths (using temp directories)

**Milestone B (0.5 days): Context injection**
- `inbox-formatter.ts`, `channel-formatter.ts`
- Update `ContextManager.assembleTaskContext()` to include inbox and channel digest
- Integration tests: agent context includes inbox messages

**Milestone C (0.5 days): Session wiring**
- Add `AsyncMessenger` to `AgentForgeSession`
- Update `HandoffManager` to write inbox on handoff completion
- Update `MessageBus` to bridge events to channels

**Milestone D (0.5 days): Channel subscriptions and agent YAML**
- Define channel subscription registry
- Add `channel_subscriptions` to agent YAML schema
- Populate subscriptions for existing team leads

**Total estimated effort: 2.5–3 focused engineering days** to deliver a complete async communication layer that eliminates unnecessary Opus invocations at the team coordination level.

---

## 9. Relationship to v3 Architecture Proposals

This proposal is additive to — and depends on — the components proposed in `2026-03-25-integration-architecture-lead-v3-synthesis.md`:

- `AsyncMessenger` is wired into `AgentForgeSession` alongside `MessageBus`, `KnowledgeStore`, and `DecisionLog`.
- The `DecisionLog` records decisions made via inbox threads (when a thread closes with a `selected_option`, the winning decision is written to `DecisionLog`).
- The `KnowledgeStore` stores channel subscription state at `project` scope (persists across sessions).
- The `IntegrationLayer` can write channel posts when external actions are dispatched (e.g., "Jira ticket PROJ-123 created" posted to #rd-updates).

### Session configuration

```typescript
const session = new AgentForgeSession({
  delegationGraph: graph,
  mcpDispatch: claudeCodeMcpDispatch,
  enabledIntegrations: ["jira", "github", "slack"],
  // NEW: async messaging
  asyncMessenger: new AsyncMessenger(
    path.join(projectRoot, ".agentforge")
  ),
  autoRules: [
    {
      onEvent: "security_alert",
      dispatchAction: "jira:create_issue",
      attributedTo: "security-agent",
    },
    {
      onEvent: "architecture_decision",
      // Also bridge to #executive-decisions channel
      bridgeToChannel: "executive-decisions",
    },
  ],
});
```

---

## Summary

The async communication system solves the single most expensive pattern in v2: Opus invocations triggered by questions that should have been resolved at the Haiku or Sonnet tier. By making communication asynchronous and file-system-native, it:

1. Eliminates model invocations from the act of sending, routing, and receiving messages.
2. Ensures executives only receive pre-digested briefings, not raw problems.
3. Provides a durable record of team deliberations (inbox threads) linked to the `DecisionLog`.
4. Is fully additive — no v2 behavior changes, no breaking changes, opt-in via `AgentForgeSession`.
5. Projected to reduce unnecessary Opus invocations by ~80% in team coordination scenarios, yielding an estimated 40% reduction in effective Opus token spend.

The system is designed to be read by humans too. Every message is a plain markdown file. Engineers can audit the full deliberation chain for any decision by browsing `.agentforge/inbox/cto/threads/`. The paper trail is the product.
