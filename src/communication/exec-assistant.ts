/**
 * ExecAssistant — Sprint 2.3b
 *
 * Reusable executive assistant pattern: filters an agent's channel inbox,
 * batches low-priority messages, and surfaces only what needs attention.
 *
 * Reduces Opus invocations by 80%+ (feedback-executive-assistants memory).
 * Opus agents get a Haiku assistant that does triage; Opus only sees the
 * filtered briefing.
 *
 * Pattern:
 *   1. Drain inbox channel for the exec agent
 *   2. Classify each message (urgent/action/fyi/noise)
 *   3. Batch FYIs into a single summary line
 *   4. Return a briefing with: urgent items, action items, fyi summary
 */

import type { ChannelMessage } from "./channel-manager.js";
import type { V4MessagePriority } from "../types/v4-api.js";

export type MessageClassification = "urgent" | "action" | "fyi" | "noise";

export interface ClassifiedMessage {
  message: ChannelMessage;
  classification: MessageClassification;
  reason: string;
}

export interface ExecBriefing {
  agentId: string;
  generatedAt: string;
  urgentItems: ClassifiedMessage[];
  actionItems: ClassifiedMessage[];
  fyiSummary: string;
  fyiCount: number;
  noiseCount: number;
  totalProcessed: number;
}

export interface ClassificationRule {
  /** Returns true if this rule applies to the message. */
  matches: (msg: ChannelMessage) => boolean;
  classification: MessageClassification;
  reason: string;
}

const DEFAULT_RULES: ClassificationRule[] = [
  {
    matches: (m) => m.priority === "urgent",
    classification: "urgent",
    reason: "Priority: urgent",
  },
  {
    matches: (m) => m.category === "escalation",
    classification: "urgent",
    reason: "Escalation requires immediate attention",
  },
  {
    matches: (m) => m.category === "decision",
    classification: "action",
    reason: "Decision or approval required",
  },
  {
    matches: (m) => m.category === "task",
    classification: "action",
    reason: "Task assignment requires acknowledgment",
  },
  {
    matches: (m) => m.priority === "high",
    classification: "action",
    reason: "Priority: high",
  },
  {
    matches: (m) => m.priority === "low",
    classification: "noise",
    reason: "Low-priority background information",
  },
  {
    matches: (m) => m.category === "review",
    classification: "fyi",
    reason: "Review update (no immediate action)",
  },
  {
    matches: (m) => m.category === "status",
    classification: "fyi",
    reason: "Status update",
  },
];

export class ExecAssistant {
  private readonly rules: ClassificationRule[];

  constructor(
    private readonly agentId: string,
    rules?: ClassificationRule[]
  ) {
    this.rules = rules ?? DEFAULT_RULES;
  }

  /**
   * Classify a single message using the rule set (first match wins).
   */
  classify(message: ChannelMessage): ClassifiedMessage {
    for (const rule of this.rules) {
      if (rule.matches(message)) {
        return { message, classification: rule.classification, reason: rule.reason };
      }
    }
    // Default
    return { message, classification: "fyi", reason: "Unclassified — default FYI" };
  }

  /**
   * Generate a briefing from a batch of unconsumed messages.
   * Returns the briefing; caller is responsible for marking messages consumed.
   */
  generateBriefing(messages: ChannelMessage[]): ExecBriefing {
    const classified = messages.map((m) => this.classify(m));
    const urgentItems = classified.filter((c) => c.classification === "urgent");
    const actionItems = classified.filter((c) => c.classification === "action");
    const fyiItems    = classified.filter((c) => c.classification === "fyi");
    const noiseItems  = classified.filter((c) => c.classification === "noise");

    const fyiSummary = fyiItems.length === 0
      ? "No FYI items."
      : fyiItems
          .map((c) => `• [${c.message.from}] ${c.message.subject}`)
          .join("\n");

    return {
      agentId: this.agentId,
      generatedAt: new Date().toISOString(),
      urgentItems,
      actionItems,
      fyiSummary,
      fyiCount: fyiItems.length,
      noiseCount: noiseItems.length,
      totalProcessed: messages.length,
    };
  }

  /**
   * Returns true if the briefing requires the Opus agent's attention
   * (has urgent or action items). If false, Opus can skip this briefing.
   */
  requiresAttention(briefing: ExecBriefing): boolean {
    return briefing.urgentItems.length > 0 || briefing.actionItems.length > 0;
  }

  /**
   * Format the briefing as a concise text summary for the Opus agent's prompt.
   */
  formatForPrompt(briefing: ExecBriefing): string {
    if (!this.requiresAttention(briefing)) {
      return `[Inbox: ${briefing.totalProcessed} messages — all FYI/noise, no action required]`;
    }
    const lines: string[] = [
      `=== Inbox Briefing (${briefing.totalProcessed} messages) ===`,
    ];
    if (briefing.urgentItems.length > 0) {
      lines.push("\n🚨 URGENT:");
      for (const item of briefing.urgentItems) {
        lines.push(`  [${item.message.from}] ${item.message.subject}: ${item.message.body.slice(0, 120)}`);
      }
    }
    if (briefing.actionItems.length > 0) {
      lines.push("\n📋 ACTION REQUIRED:");
      for (const item of briefing.actionItems) {
        lines.push(`  [${item.message.from}] ${item.message.subject}: ${item.message.body.slice(0, 120)}`);
      }
    }
    if (briefing.fyiCount > 0) {
      lines.push(`\nℹ️  FYI (${briefing.fyiCount} items):\n${briefing.fyiSummary}`);
    }
    return lines.join("\n");
  }
}
