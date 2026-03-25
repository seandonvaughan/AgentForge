/**
 * FeedbackCollector — persists agent feedback as markdown files.
 *
 * Each feedback entry is written to
 *   .agentforge/feedback/YYYY-MM-DD-{agent}-{id}.md
 * with YAML frontmatter so the files are both human-readable and
 * machine-parseable by loadAllFeedback().
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  AgentFeedback,
  FeedbackCategory,
  FeedbackPriority,
  FeedbackSummary,
} from "../types/feedback.js";

export class FeedbackCollector {
  private feedbackDir: string;

  constructor(projectRoot: string) {
    this.feedbackDir = path.join(projectRoot, ".agentforge", "feedback");
  }

  /**
   * Agent submits feedback as a markdown file.
   *
   * Creates .agentforge/feedback/YYYY-MM-DD-{agent}-{id}.md with YAML
   * frontmatter (category, priority, agent, timestamp) and a body
   * containing title, description, context details, and suggestion.
   *
   * @returns The absolute path of the written file.
   */
  async submitFeedback(feedback: AgentFeedback): Promise<string> {
    await fs.mkdir(this.feedbackDir, { recursive: true });

    const date = feedback.timestamp.slice(0, 10); // YYYY-MM-DD
    const safeName = feedback.agent.replace(/[^a-zA-Z0-9-_]/g, "-");
    const filename = `${date}-${safeName}-${feedback.id}.md`;
    const filePath = path.join(this.feedbackDir, filename);

    const contextLines: string[] = [];
    if (feedback.context.task) {
      contextLines.push(`- **Task:** ${feedback.context.task}`);
    }
    if (feedback.context.files_involved && feedback.context.files_involved.length > 0) {
      contextLines.push(`- **Files:** ${feedback.context.files_involved.join(", ")}`);
    }
    if (feedback.context.model_used) {
      contextLines.push(`- **Model:** ${feedback.context.model_used}`);
    }
    if (feedback.context.tokens_consumed !== undefined) {
      contextLines.push(`- **Tokens:** ${feedback.context.tokens_consumed}`);
    }
    if (feedback.context.duration_ms !== undefined) {
      contextLines.push(`- **Duration:** ${feedback.context.duration_ms}ms`);
    }

    const contextSection =
      contextLines.length > 0
        ? `\n## Context\n\n${contextLines.join("\n")}\n`
        : "";

    const content = `---
id: ${feedback.id}
agent: ${feedback.agent}
category: ${feedback.category}
priority: ${feedback.priority}
timestamp: ${feedback.timestamp}
---

# ${feedback.title}

## Description

${feedback.description}
${contextSection}
## Suggestion

${feedback.suggestion}
`;

    await fs.writeFile(filePath, content, "utf-8");
    return filePath;
  }

  /**
   * Load all feedback from the feedback directory.
   *
   * Reads every .md file in the feedback directory, parses the YAML
   * frontmatter for structured fields, and reconstructs AgentFeedback
   * objects. Files that cannot be parsed are silently skipped.
   */
  async loadAllFeedback(): Promise<AgentFeedback[]> {
    let files: string[];
    try {
      const entries = await fs.readdir(this.feedbackDir);
      files = entries.filter((f) => f.endsWith(".md"));
    } catch {
      // Directory doesn't exist yet — no feedback collected
      return [];
    }

    const results: AgentFeedback[] = [];

    for (const file of files) {
      try {
        const raw = await fs.readFile(path.join(this.feedbackDir, file), "utf-8");
        const feedback = parseFeedbackMarkdown(raw);
        if (feedback) {
          results.push(feedback);
        }
      } catch {
        // Skip unreadable or malformed files
      }
    }

    return results;
  }

  /**
   * Generate a summary aggregating counts across all feedback entries.
   */
  async getSummary(): Promise<FeedbackSummary> {
    const entries = await this.loadAllFeedback();

    const by_category: Record<FeedbackCategory, number> = {
      optimization: 0,
      bug: 0,
      feature: 0,
      process: 0,
      cost: 0,
      quality: 0,
    };

    const by_priority: Record<FeedbackPriority, number> = {
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
    };

    const by_agent: Record<string, number> = {};

    for (const entry of entries) {
      by_category[entry.category] = (by_category[entry.category] ?? 0) + 1;
      by_priority[entry.priority] = (by_priority[entry.priority] ?? 0) + 1;
      by_agent[entry.agent] = (by_agent[entry.agent] ?? 0) + 1;
    }

    return {
      total: entries.length,
      by_category,
      by_priority,
      by_agent,
      entries,
    };
  }

  /** Get feedback filtered by category. */
  async getByCategory(category: FeedbackCategory): Promise<AgentFeedback[]> {
    const all = await this.loadAllFeedback();
    return all.filter((f) => f.category === category);
  }

  /** Get feedback filtered by priority. */
  async getByPriority(priority: FeedbackPriority): Promise<AgentFeedback[]> {
    const all = await this.loadAllFeedback();
    return all.filter((f) => f.priority === priority);
  }

  /** Get feedback filtered by agent name. */
  async getByAgent(agent: string): Promise<AgentFeedback[]> {
    const all = await this.loadAllFeedback();
    return all.filter((f) => f.agent === agent);
  }
}

// ---------------------------------------------------------------------------
//  Internal helpers
// ---------------------------------------------------------------------------

/**
 * Parses a feedback markdown file back into an AgentFeedback object.
 *
 * Extracts YAML frontmatter fields for structured data, then picks
 * the title, description, context bullet list, and suggestion from the body.
 */
function parseFeedbackMarkdown(raw: string): AgentFeedback | null {
  // Split frontmatter from body
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fmMatch) return null;

  const frontmatter = fmMatch[1];
  const body = fmMatch[2];

  // Parse simple key: value frontmatter lines
  const fm: Record<string, string> = {};
  for (const line of frontmatter.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    fm[key] = value;
  }

  if (!fm["id"] || !fm["agent"] || !fm["category"] || !fm["priority"] || !fm["timestamp"]) {
    return null;
  }

  // Extract title from the first H1 heading
  const titleMatch = body.match(/^#\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : "";

  // Extract description — text between "## Description" and the next "##"
  const descMatch = body.match(/##\s+Description\n\n([\s\S]*?)(?=\n##|\s*$)/);
  const description = descMatch ? descMatch[1].trim() : "";

  // Extract suggestion — text after "## Suggestion"
  const suggMatch = body.match(/##\s+Suggestion\n\n([\s\S]*?)(?=\n##|\s*$)/);
  const suggestion = suggMatch ? suggMatch[1].trim() : "";

  // Extract optional context bullets
  const context: AgentFeedback["context"] = {};
  const ctxMatch = body.match(/##\s+Context\n\n([\s\S]*?)(?=\n##|\s*$)/);
  if (ctxMatch) {
    const ctxBlock = ctxMatch[1];

    const taskM = ctxBlock.match(/\*\*Task:\*\*\s+(.+)/);
    if (taskM) context.task = taskM[1].trim();

    const filesM = ctxBlock.match(/\*\*Files:\*\*\s+(.+)/);
    if (filesM) {
      context.files_involved = filesM[1].split(",").map((s) => s.trim());
    }

    const modelM = ctxBlock.match(/\*\*Model:\*\*\s+(.+)/);
    if (modelM) context.model_used = modelM[1].trim() as AgentFeedback["context"]["model_used"];

    const tokensM = ctxBlock.match(/\*\*Tokens:\*\*\s+(\d+)/);
    if (tokensM) context.tokens_consumed = parseInt(tokensM[1], 10);

    const durM = ctxBlock.match(/\*\*Duration:\*\*\s+(\d+)ms/);
    if (durM) context.duration_ms = parseInt(durM[1], 10);
  }

  return {
    id: fm["id"],
    agent: fm["agent"],
    category: fm["category"] as FeedbackCategory,
    priority: fm["priority"] as FeedbackPriority,
    title,
    description,
    context,
    suggestion,
    timestamp: fm["timestamp"],
  };
}

export { randomUUID };
