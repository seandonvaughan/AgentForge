/**
 * career-hook.ts — lightweight CareerStore adapter for the server package.
 *
 * Mirrors the postTaskHook interface from src/lifecycle/career-store.ts
 * without crossing the package boundary. Uses an in-memory store only
 * (no DB) since the server package has no direct access to the root src/
 * lifecycle module.
 *
 * If a full DB-backed CareerStore is needed, wire it via the server's
 * plugin initialisation layer (opts injection).
 */

// ---------------------------------------------------------------------------
// Minimal types (subset of src/types/lifecycle.ts)
// ---------------------------------------------------------------------------

export interface TaskMemory {
  taskId: string;
  timestamp: string;
  objective: string;
  approach: string;
  outcome: 'success' | 'failure';
  lessonsLearned: string[];
  filesModified: string[];
  collaborators: string[];
  difficulty: number;
  tokensUsed: number;
}

export interface PostTaskInput {
  taskId: string;
  success: boolean;
  summary: string;
  filesModified?: string[];
  tokensUsed?: number;
  durationMs?: number;
  skills?: string[];
}

export interface SkillLevelUp {
  skill: string;
  newLevel: number;
}

// ---------------------------------------------------------------------------
// InMemoryCareerHook
// ---------------------------------------------------------------------------

const MAX_TASK_HISTORY = 50;

/**
 * In-memory career hook. Records task outcomes and tracks simple skill
 * exercise counts per agent. Does not persist to disk or DB.
 */
export class InMemoryCareerHook {
  private taskHistories = new Map<string, TaskMemory[]>();
  private skillExerciseCounts = new Map<string, Map<string, number>>();

  postTaskHook(
    agentId: string,
    input: PostTaskInput,
  ): { taskMemory: TaskMemory; skillLevelUps: SkillLevelUp[] } {
    const memory: TaskMemory = {
      taskId: input.taskId,
      timestamp: new Date().toISOString(),
      objective: input.summary,
      approach: '',
      outcome: input.success ? 'success' : 'failure',
      lessonsLearned: [],
      filesModified: input.filesModified ?? [],
      collaborators: [],
      difficulty: 3,
      tokensUsed: input.tokensUsed ?? 0,
    };

    // Append to rolling history
    const history = this.taskHistories.get(agentId) ?? [];
    history.push(memory);
    if (history.length > MAX_TASK_HISTORY) {
      history.splice(0, history.length - MAX_TASK_HISTORY);
    }
    this.taskHistories.set(agentId, history);

    // Track skill exercises and detect simple level-ups (every 10 exercises)
    const skillLevelUps: SkillLevelUp[] = [];
    const agentSkills = this.skillExerciseCounts.get(agentId) ?? new Map<string, number>();

    for (const skillName of input.skills ?? []) {
      const prev = agentSkills.get(skillName) ?? 0;
      const next = prev + 1;
      agentSkills.set(skillName, next);

      // Simple level-up rule: every 10 exercises gains one level (max 5)
      const prevLevel = Math.min(5, Math.floor(prev / 10) + 1);
      const newLevel = Math.min(5, Math.floor(next / 10) + 1);
      if (newLevel > prevLevel) {
        skillLevelUps.push({ skill: skillName, newLevel });
      }
    }

    this.skillExerciseCounts.set(agentId, agentSkills);

    return { taskMemory: memory, skillLevelUps };
  }

  getTaskHistory(agentId: string): TaskMemory[] {
    return [...(this.taskHistories.get(agentId) ?? [])];
  }
}

/** Singleton instance shared across all route handlers in the server. */
export const careerHook = new InMemoryCareerHook();
