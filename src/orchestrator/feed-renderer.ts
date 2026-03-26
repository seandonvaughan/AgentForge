import type { TeamModeMessage, FeedEntry } from "../types/team-mode.js";

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
}