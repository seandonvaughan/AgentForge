/**
 * Shared Context Manager for the AgentForge Orchestrator.
 *
 * Manages three levels of context for multi-agent collaboration:
 *
 * 1. **Task Context** — Scoped to a single agent invocation. Built from
 *    the agent's auto_include files, the task description, and team decisions.
 *    Never includes another agent's raw session history (context isolation).
 *
 * 2. **Team Context** — Shared key-value state across agents for the current
 *    session (decisions, artifacts, progress).
 *
 * 3. **Decisions** — An append-only log of strategic decisions with agent
 *    attribution, rationale, and timestamps.
 */

import type { AgentTemplate } from "../types/agent.js";

/** A recorded strategic decision made by an agent. */
export interface Decision {
  /** Name of the agent that made the decision. */
  agent: string;
  /** What was decided. */
  decision: string;
  /** Why it was decided. */
  rationale: string;
  /** ISO-8601 timestamp of when the decision was recorded. */
  timestamp: string;
}

/** Options for assembleTaskContext beyond the agent template. */
export interface AssembleOptions {
  /** Additional file paths to include in context. */
  files?: string[];
}

/** A function that reads a file and returns its contents as a string. */
export type FileReader = (path: string) => string;

/**
 * Assembles scoped context for agent invocations and manages shared
 * team state and decision records.
 */
export class ContextManager {
  private readonly teamContext: Map<string, unknown> = new Map();
  private readonly decisions: Decision[] = [];
  private fileReader: FileReader | null = null;

  /**
   * Injects a file-reading function used by assembleTaskContext to load
   * auto_include and additional files. When not set, file sections are
   * silently skipped.
   */
  setFileReader(reader: FileReader): void {
    this.fileReader = reader;
  }

  /**
   * Builds a scoped context string for a specific agent invocation.
   *
   * Includes:
   * - Task description
   * - Auto-include file contents (up to max_files)
   * - Additional file contents passed via options (sharing the max_files budget)
   * - All team decisions recorded so far
   *
   * Excludes:
   * - Other agents' session history (keys prefixed with "session:")
   *
   * Files that fail to read are silently skipped.
   */
  assembleTaskContext(
    agent: AgentTemplate,
    task: string,
    options?: AssembleOptions,
  ): string {
    const sections: string[] = [];
    const maxFiles = agent.context.max_files;

    // --- Section 1: Task description ---
    sections.push("## Task\n");
    sections.push(task);

    // --- Section 2: File contents (auto_include + additional) ---
    if (this.fileReader) {
      const autoInclude = agent.context.auto_include;
      const additionalFiles = options?.files ?? [];

      // Auto-include gets priority, then additional files, capped at max_files
      const allFiles = [...autoInclude, ...additionalFiles];
      const filesToLoad = allFiles.slice(0, maxFiles);

      const loadedSections: string[] = [];
      for (const filePath of filesToLoad) {
        try {
          const content = this.fileReader(filePath);
          loadedSections.push(`### File: ${filePath}\n\n${content}`);
        } catch {
          // Silently skip unreadable files
        }
      }

      if (loadedSections.length > 0) {
        sections.push("\n## Context Files\n");
        sections.push(loadedSections.join("\n\n"));
      }
    }

    // --- Section 3: Team decisions ---
    if (this.decisions.length > 0) {
      sections.push("\n## Team Decisions\n");
      for (const d of this.decisions) {
        sections.push(
          `- [${d.agent}] ${d.decision} — ${d.rationale} (${d.timestamp})`,
        );
      }
    }

    return sections.join("\n");
  }

  /**
   * Stores a value in team-wide shared state, accessible to all agents.
   */
  updateTeamContext(key: string, value: unknown): void {
    this.teamContext.set(key, value);
  }

  /**
   * Returns a shallow copy of all team-wide shared state.
   *
   * Keys prefixed with "session:" are agent-private and excluded from
   * assembleTaskContext for other agents, but still returned here for
   * orchestrator inspection.
   */
  getTeamContext(): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of this.teamContext) {
      result[key] = value;
    }
    return result;
  }

  /**
   * Records a strategic decision made by an agent.
   *
   * Decisions are append-only and included in every agent's task context
   * so the whole team stays aligned.
   */
  saveDecision(agent: string, decision: string, rationale: string): void {
    this.decisions.push({
      agent,
      decision,
      rationale,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Returns a copy of all recorded decisions.
   */
  getDecisions(): Decision[] {
    return this.decisions.map((d) => ({ ...d }));
  }
}
