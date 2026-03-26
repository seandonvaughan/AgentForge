import type { TeamModeMessage, FeedEntry, FeedDisplayTier } from "../types/team-mode.js";

function agentName(address: string): string {
  return address.split(":")[1] ?? address;
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + "...";
}

export class FeedRenderer {
  private entries: FeedEntry[] = [];

  formatMessage(message: TeamModeMessage): string {
    const from = agentName(message.from);
    const to = agentName(message.to);
    const summary = truncate(message.content, 80);
    switch (message.type) {
      case "task":       return `[${from} -> ${to}]  task: ${summary}`;
      case "result":     return `[${from}]  completed: ${summary}`;
      case "escalation": return `[${from} -> ${to}]  escalation: ${summary}`;
      case "decision":   return `[${from} -> ${to}]  decision: ${summary}`;
      case "status":     return `[${from}]  ${summary}`;
      case "direct":     return `[${from} -> ${to}]  ${summary}`;
      default:           return `[${from}]  ${summary}`;
    }
  }

  toFeedEntry(message: TeamModeMessage): FeedEntry {
    return {
      timestamp: message.timestamp,
      source: message.from,
      target: message.to,
      type: message.type,
      summary: truncate(message.content, 120),
      content: message.content,
    };
  }

  addMessage(message: TeamModeMessage): FeedEntry {
    const entry = this.toFeedEntry(message);
    this.entries.push(entry);
    return entry;
  }

  getEntries(): FeedEntry[] {
    return [...this.entries];
  }

  getRecentEntries(count: number): FeedEntry[] {
    return this.entries.slice(-count);
  }

  clear(): void {
    this.entries = [];
  }

  getDisplayTier(message: TeamModeMessage): FeedDisplayTier {
    if (message.priority === "urgent") return "full";
    switch (message.type) {
      case "escalation":
      case "decision":
        return "full";
      case "task":
      case "result":
        return "oneliner";
      case "status":
        return "marker";
      case "direct":
        return message.from === "conduit:user" ? "full" : "oneliner";
      default:
        return "silent";
    }
  }

  formatByTier(message: TeamModeMessage): string | null {
    const tier = this.getDisplayTier(message);
    switch (tier) {
      case "full":
        return this.formatMessage(message);
      case "oneliner": {
        const from = agentName(message.from);
        const summary = truncate(message.content, 60);
        return `  ${from}: ${summary}`;
      }
      case "marker":
        return `  · ${agentName(message.from)}`;
      case "silent":
        return null;
    }
  }

  formatCostMilestone(spentUsd: number, budgetUsd: number): string | null {
    const pct = spentUsd / budgetUsd;
    if (pct >= 0.9) return `  ⚠ Budget 90% used ($${spentUsd.toFixed(2)} / $${budgetUsd.toFixed(2)})`;
    if (pct >= 0.75) return `  ⚡ Budget 75% used ($${spentUsd.toFixed(2)} / $${budgetUsd.toFixed(2)})`;
    if (pct >= 0.5) return `  · Budget 50% used ($${spentUsd.toFixed(2)} / $${budgetUsd.toFixed(2)})`;
    return null;
  }
}