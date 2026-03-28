/**
 * CareerStore — Agent Identity Hub Phase 2
 *
 * Manages per-agent career progression: task memories, skill profiles,
 * institutional knowledge, career events, and performance metrics.
 */

import { randomUUID } from "node:crypto";

import type {
  TaskMemory,
  SkillProfile,
  SkillLevel,
  KnowledgeEntry,
  KnowledgeCategory,
  AgentCareerRecord,
  CareerEvent,
  CareerEventType,
  PerformanceMetrics,
  SeniorityLevel,
  AgentRole,
} from "../types/lifecycle.js";
import {
  SKILL_LEVEL_THRESHOLDS,
  SENIORITY_CONFIG,
} from "../types/lifecycle.js";

import type { AgentDatabase } from "../db/database.js";
import type { AutonomyGovernor } from "../flywheel/autonomy-governor.js";
import { AutonomyTier } from "../types/v4-api.js";

// ---------------------------------------------------------------------------
// DB row shapes
// ---------------------------------------------------------------------------

interface TaskMemoryRow {
  id: string;
  agent_id: string;
  task_id: string;
  timestamp: string;
  objective: string | null;
  approach: string | null;
  outcome: string;
  lessons_learned: string | null;
  files_modified: string | null;
  collaborators: string | null;
  difficulty: number | null;
  tokens_used: number | null;
}

interface AgentSkillRow {
  agent_id: string;
  skill_name: string;
  level: number;
  exercise_count: number;
  success_rate: number;
  last_exercised: string | null;
  unlocked_capabilities: string | null;
}

interface KnowledgeRow {
  id: string;
  team_id: string;
  category: string;
  content: string;
  source: string | null;
  confidence: number;
  reference_links: string | null;
  created_at: string;
  last_validated: string | null;
}

interface CareerEventRow {
  id: string;
  agent_id: string;
  event_type: string;
  details: string | null;
  timestamp: string;
}

interface AgentCareerRow {
  agent_id: string;
  hired_at: string;
  current_team: string;
  current_role: string;
  seniority: string;
  autonomy_tier: number;
  tasks_completed: number;
  success_rate: number;
  avg_task_duration: number;
  peer_review_score: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MAX_TASK_HISTORY = 50;
const KNOWLEDGE_CONFIDENCE_MIN = 0.3;
const KNOWLEDGE_STALE_DAYS = 30;
const DEFAULT_DECAY_RATE = 0.1;

function rowToTaskMemory(row: TaskMemoryRow): TaskMemory {
  return {
    taskId: row.task_id,
    timestamp: row.timestamp,
    objective: row.objective ?? "",
    approach: row.approach ?? "",
    outcome: row.outcome as TaskMemory["outcome"],
    lessonsLearned: row.lessons_learned ? (JSON.parse(row.lessons_learned) as string[]) : [],
    filesModified: row.files_modified ? (JSON.parse(row.files_modified) as string[]) : [],
    collaborators: row.collaborators ? (JSON.parse(row.collaborators) as string[]) : [],
    difficulty: row.difficulty ?? 1,
    tokensUsed: row.tokens_used ?? 0,
  };
}

function rowToSkillLevel(row: AgentSkillRow): SkillLevel {
  return {
    name: row.skill_name,
    level: row.level,
    exerciseCount: row.exercise_count,
    successRate: row.success_rate,
    lastExercised: row.last_exercised ?? new Date().toISOString(),
    unlockedCapabilities: row.unlocked_capabilities
      ? (JSON.parse(row.unlocked_capabilities) as string[])
      : [],
  };
}

function rowToKnowledgeEntry(row: KnowledgeRow): KnowledgeEntry {
  return {
    id: row.id,
    teamId: row.team_id,
    category: row.category as KnowledgeCategory,
    content: row.content,
    source: row.source ?? "",
    confidence: row.confidence,
    references: row.reference_links ? (JSON.parse(row.reference_links) as string[]) : [],
    createdAt: row.created_at,
    lastValidated: row.last_validated ?? row.created_at,
  };
}

function rowToCareerEvent(row: CareerEventRow): CareerEvent {
  return {
    id: row.id,
    agentId: row.agent_id,
    eventType: row.event_type as CareerEventType,
    details: row.details ? (JSON.parse(row.details) as Record<string, unknown>) : {},
    timestamp: row.timestamp,
  };
}

// ---------------------------------------------------------------------------
// CareerStore
// ---------------------------------------------------------------------------

export interface CareerStoreOptions {
  db?: AgentDatabase;
  governor?: AutonomyGovernor;
}

export class CareerStore {
  private readonly db?: AgentDatabase;
  private readonly governor?: AutonomyGovernor;

  /** Per-agent rolling task history (max 50). */
  private taskHistories = new Map<string, TaskMemory[]>();

  /** Per-agent skill profiles. */
  private skillProfiles = new Map<string, SkillProfile>();

  /** Per-team institutional knowledge. */
  private knowledge = new Map<string, KnowledgeEntry[]>();

  /** Per-agent career events. */
  private careerEvents = new Map<string, CareerEvent[]>();

  constructor({ db, governor }: CareerStoreOptions = {}) {
    this.db = db;
    this.governor = governor;
  }

  // -------------------------------------------------------------------------
  // § 1 — Task Memory
  // -------------------------------------------------------------------------

  /**
   * Append a new task memory for an agent, keep the last 50, and persist to DB.
   */
  recordTaskOutcome(agentId: string, memory: TaskMemory): void {
    const history = this.taskHistories.get(agentId) ?? [];
    history.push(memory);
    if (history.length > MAX_TASK_HISTORY) {
      history.splice(0, history.length - MAX_TASK_HISTORY);
    }
    this.taskHistories.set(agentId, history);

    if (this.db) {
      this.db.getDb().prepare<[
        string, string, string, string, string, string,
        string, string, string, string, number, number
      ]>(`
        INSERT OR REPLACE INTO task_memories
          (id, agent_id, task_id, timestamp, objective, approach,
           outcome, lessons_learned, files_modified, collaborators,
           difficulty, tokens_used)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        randomUUID(),
        agentId,
        memory.taskId,
        memory.timestamp,
        memory.objective,
        memory.approach,
        memory.outcome,
        JSON.stringify(memory.lessonsLearned),
        JSON.stringify(memory.filesModified),
        JSON.stringify(memory.collaborators),
        memory.difficulty,
        memory.tokensUsed,
      );

      // Update performance metrics in agent_careers
      this._updatePerformanceMetrics(agentId);
    }
  }

  /**
   * Return the most recent `limit` memories for an agent.
   */
  getTaskHistory(agentId: string, limit?: number): TaskMemory[] {
    const history = this.taskHistories.get(agentId) ?? [];
    if (limit !== undefined) {
      return history.slice(-limit);
    }
    return [...history];
  }

  /**
   * Return the context window of memories to inject before a new run.
   */
  getRecentContext(agentId: string, contextWindowSize: number): TaskMemory[] {
    return this.getTaskHistory(agentId, contextWindowSize);
  }

  // -------------------------------------------------------------------------
  // § 2 — Skill Profile
  // -------------------------------------------------------------------------

  /**
   * Record a skill exercise, check for level-up, persist to DB, and return
   * the updated SkillLevel.
   */
  recordSkillExercise(agentId: string, skillName: string, success: boolean): SkillLevel {
    const profile = this._ensureSkillProfile(agentId);

    let skill = profile.skills[skillName];
    if (!skill) {
      skill = {
        name: skillName,
        level: 1,
        exerciseCount: 0,
        successRate: 0,
        lastExercised: new Date().toISOString(),
        unlockedCapabilities: [],
      };
    }

    skill.exerciseCount++;
    // Recompute success rate as a running average
    const prevSuccesses = Math.round(skill.successRate * (skill.exerciseCount - 1));
    const newSuccesses = prevSuccesses + (success ? 1 : 0);
    skill.successRate = newSuccesses / skill.exerciseCount;
    skill.lastExercised = new Date().toISOString();

    profile.skills[skillName] = skill;
    this.skillProfiles.set(agentId, profile);

    // Check for level-up
    const { leveledUp, newLevel } = this.evaluateSkillLevelUp(agentId, skillName);
    if (leveledUp) {
      skill.level = newLevel;
    }

    if (this.db) {
      this.db.getDb().prepare<[
        string, string, number, number, number, string, string
      ]>(`
        INSERT INTO agent_skills
          (agent_id, skill_name, level, exercise_count, success_rate,
           last_exercised, unlocked_capabilities)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(agent_id, skill_name) DO UPDATE SET
          level = excluded.level,
          exercise_count = excluded.exercise_count,
          success_rate = excluded.success_rate,
          last_exercised = excluded.last_exercised,
          unlocked_capabilities = excluded.unlocked_capabilities
      `).run(
        agentId,
        skillName,
        skill.level,
        skill.exerciseCount,
        skill.successRate,
        skill.lastExercised,
        JSON.stringify(skill.unlockedCapabilities),
      );
    }

    return { ...skill };
  }

  /**
   * Determine whether a skill qualifies for a level-up.
   * Returns the result without persisting (side-effect is updating in-memory level).
   */
  evaluateSkillLevelUp(
    agentId: string,
    skillName: string,
  ): { leveledUp: boolean; newLevel: number } {
    const profile = this.skillProfiles.get(agentId);
    if (!profile) return { leveledUp: false, newLevel: 1 };

    const skill = profile.skills[skillName];
    if (!skill) return { leveledUp: false, newLevel: 1 };

    const currentLevel = skill.level;
    const nextLevel = currentLevel + 1;
    if (nextLevel > 5) return { leveledUp: false, newLevel: currentLevel };

    const threshold = SKILL_LEVEL_THRESHOLDS[nextLevel];
    if (!threshold) return { leveledUp: false, newLevel: currentLevel };

    if (
      skill.exerciseCount >= threshold.minExercises &&
      skill.successRate >= threshold.minSuccessRate
    ) {
      skill.level = nextLevel;
      return { leveledUp: true, newLevel: nextLevel };
    }

    return { leveledUp: false, newLevel: currentLevel };
  }

  /**
   * Return the full skill profile for an agent.
   */
  getSkillProfile(agentId: string): SkillProfile {
    return this._ensureSkillProfile(agentId);
  }

  /**
   * Return a single skill level or null if the skill has never been exercised.
   */
  getSkillLevel(agentId: string, skillName: string): SkillLevel | null {
    const profile = this.skillProfiles.get(agentId);
    if (!profile) return null;
    return profile.skills[skillName] ?? null;
  }

  // -------------------------------------------------------------------------
  // § 3 — Institutional Knowledge
  // -------------------------------------------------------------------------

  /**
   * Persist a new knowledge entry.
   */
  addKnowledge(entry: KnowledgeEntry): void {
    const entries = this.knowledge.get(entry.teamId) ?? [];
    entries.push(entry);
    this.knowledge.set(entry.teamId, entries);

    if (this.db) {
      this.db.getDb().prepare<[
        string, string, string, string, string, number, string, string, string
      ]>(`
        INSERT OR REPLACE INTO institutional_knowledge
          (id, team_id, category, content, source, confidence,
           reference_links, created_at, last_validated)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        entry.id,
        entry.teamId,
        entry.category,
        entry.content,
        entry.source,
        entry.confidence,
        JSON.stringify(entry.references),
        entry.createdAt,
        entry.lastValidated,
      );
    }
  }

  /**
   * Return all team knowledge entries with confidence > 0.3.
   */
  getTeamKnowledge(teamId: string): KnowledgeEntry[] {
    const entries = this.knowledge.get(teamId) ?? [];
    return entries.filter((e) => e.confidence > KNOWLEDGE_CONFIDENCE_MIN);
  }

  /**
   * Mark a knowledge entry as recently validated (confidence reset to 1.0).
   */
  validateKnowledge(entryId: string): void {
    const now = new Date().toISOString();

    // Update in-memory
    for (const entries of this.knowledge.values()) {
      const entry = entries.find((e) => e.id === entryId);
      if (entry) {
        entry.lastValidated = now;
        entry.confidence = 1.0;
      }
    }

    if (this.db) {
      this.db.getDb().prepare<[string, string]>(`
        UPDATE institutional_knowledge
        SET last_validated = ?, confidence = 1.0
        WHERE id = ?
      `).run(now, entryId);
    }
  }

  /**
   * Decay confidence of entries that have not been validated in 30+ days.
   * Returns the number of entries decayed.
   */
  decayStaleKnowledge(teamId: string, decayRate: number = DEFAULT_DECAY_RATE): number {
    const now = Date.now();
    const staleCutoffMs = KNOWLEDGE_STALE_DAYS * 24 * 60 * 60 * 1000;

    const entries = this.knowledge.get(teamId) ?? [];
    let decayed = 0;

    for (const entry of entries) {
      const lastValidated = new Date(entry.lastValidated).getTime();
      if (now - lastValidated >= staleCutoffMs) {
        entry.confidence = entry.confidence * (1 - decayRate);
        decayed++;

        if (this.db) {
          this.db.getDb().prepare<[number, string]>(`
            UPDATE institutional_knowledge
            SET confidence = ?
            WHERE id = ?
          `).run(entry.confidence, entry.id);
        }
      }
    }

    return decayed;
  }

  // -------------------------------------------------------------------------
  // § 4 — Career Record
  // -------------------------------------------------------------------------

  /**
   * Compose and return the full career record for an agent from all stores.
   */
  getCareerRecord(agentId: string): AgentCareerRecord | null {
    if (!this.db) {
      // Build from in-memory stores only — requires agent_careers row to exist
      return null;
    }

    const careerRow = this.db.getDb()
      .prepare<[string], AgentCareerRow>(
        "SELECT * FROM agent_careers WHERE agent_id = ?",
      )
      .get(agentId);

    if (!careerRow) return null;

    const tier = (this.governor?.getTier(agentId) ?? careerRow.autonomy_tier) as AutonomyTier;

    const metrics: PerformanceMetrics = {
      tasksCompleted: careerRow.tasks_completed,
      successRate: careerRow.success_rate,
      avgTaskDuration: careerRow.avg_task_duration,
      peerReviewScore: careerRow.peer_review_score,
      mentorshipCount: 0,
    };

    const record: AgentCareerRecord = {
      agentId,
      hiredAt: careerRow.hired_at,
      currentTeam: careerRow.current_team,
      currentRole: careerRow.current_role as AgentRole,
      seniority: careerRow.seniority as SeniorityLevel,
      autonomyTier: tier,
      skillProfile: this._ensureSkillProfile(agentId),
      taskHistory: this.getTaskHistory(agentId),
      careerEvents: this.careerEvents.get(agentId) ?? [],
      performanceMetrics: metrics,
    };

    return record;
  }

  /**
   * Append a career event and persist to DB.
   */
  recordCareerEvent(event: CareerEvent): void {
    const events = this.careerEvents.get(event.agentId) ?? [];
    events.push(event);
    this.careerEvents.set(event.agentId, events);

    if (this.db) {
      this.db.getDb().prepare<[string, string, string, string, string]>(`
        INSERT INTO career_events (id, agent_id, event_type, details, timestamp)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        event.id,
        event.agentId,
        event.eventType,
        JSON.stringify(event.details),
        event.timestamp,
      );
    }
  }

  /**
   * Record a promotion event and update agent_careers seniority.
   * Also evaluates governor promotion if one is available.
   */
  promote(agentId: string, newSeniority: SeniorityLevel, approvedBy: string): CareerEvent {
    const event: CareerEvent = {
      id: randomUUID(),
      agentId,
      eventType: "promoted",
      details: {
        newSeniority,
        approvedBy,
        promotedAt: new Date().toISOString(),
      },
      timestamp: new Date().toISOString(),
    };

    this.recordCareerEvent(event);

    if (this.db) {
      this.db.getDb().prepare<[string, string]>(`
        UPDATE agent_careers
        SET seniority = ?, updated_at = datetime('now')
        WHERE agent_id = ?
      `).run(newSeniority, agentId);
    }

    if (this.governor) {
      this.governor.evaluatePromotion(agentId);
    }

    return event;
  }

  // -------------------------------------------------------------------------
  // § 5 — Post-task Hook
  // -------------------------------------------------------------------------

  /**
   * Called after every task completion. Creates a task memory, records skill
   * exercises, and updates the autonomy governor.
   */
  postTaskHook(
    agentId: string,
    taskResult: {
      taskId: string;
      success: boolean;
      summary: string;
      filesModified?: string[];
      tokensUsed?: number;
      durationMs?: number;
      skills?: string[];
    },
  ): {
    taskMemory: TaskMemory;
    skillLevelUps: Array<{ skill: string; newLevel: number }>;
  } {
    const outcome: TaskMemory["outcome"] = taskResult.success ? "success" : "failure";

    const taskMemory: TaskMemory = {
      taskId: taskResult.taskId,
      timestamp: new Date().toISOString(),
      objective: taskResult.summary,
      approach: "",
      outcome,
      lessonsLearned: [],
      filesModified: taskResult.filesModified ?? [],
      collaborators: [],
      difficulty: 3,
      tokensUsed: taskResult.tokensUsed ?? 0,
    };

    // 1. Record the task outcome
    this.recordTaskOutcome(agentId, taskMemory);

    // 2. Record skill exercises and track level-ups
    const skillLevelUps: Array<{ skill: string; newLevel: number }> = [];

    for (const skillName of taskResult.skills ?? []) {
      const before = this.getSkillLevel(agentId, skillName);
      const levelBefore = before?.level ?? 1;

      const updated = this.recordSkillExercise(agentId, skillName, taskResult.success);

      if (updated.level > levelBefore) {
        skillLevelUps.push({ skill: skillName, newLevel: updated.level });
      }
    }

    // 3. Update autonomy governor
    if (this.governor) {
      try {
        if (taskResult.success) {
          this.governor.recordSuccess(agentId);
        } else {
          this.governor.recordFailure(agentId);
        }
      } catch {
        // Agent may not be registered yet — ignore
      }
    }

    return { taskMemory, skillLevelUps };
  }

  // -------------------------------------------------------------------------
  // § 6 — Static Factory
  // -------------------------------------------------------------------------

  /**
   * Load all career data from the database and return a fully-hydrated CareerStore.
   */
  static loadFromDb(db: AgentDatabase, governor?: AutonomyGovernor): CareerStore {
    const store = new CareerStore({ db, governor });

    const rawDb = db.getDb();

    // Load task memories
    const memoryRows = rawDb
      .prepare<[], TaskMemoryRow>("SELECT * FROM task_memories ORDER BY timestamp ASC")
      .all();
    for (const row of memoryRows) {
      const history = store.taskHistories.get(row.agent_id) ?? [];
      history.push(rowToTaskMemory(row));
      // Enforce window size during load
      if (history.length > MAX_TASK_HISTORY) {
        history.splice(0, history.length - MAX_TASK_HISTORY);
      }
      store.taskHistories.set(row.agent_id, history);
    }

    // Load skill profiles
    const skillRows = rawDb
      .prepare<[], AgentSkillRow>("SELECT * FROM agent_skills")
      .all();
    for (const row of skillRows) {
      const profile = store.skillProfiles.get(row.agent_id) ?? {
        agentId: row.agent_id,
        skills: {},
      };
      profile.skills[row.skill_name] = rowToSkillLevel(row);
      store.skillProfiles.set(row.agent_id, profile);
    }

    // Load institutional knowledge
    const knowledgeRows = rawDb
      .prepare<[], KnowledgeRow>(
        "SELECT * FROM institutional_knowledge ORDER BY created_at ASC",
      )
      .all();
    for (const row of knowledgeRows) {
      const entries = store.knowledge.get(row.team_id) ?? [];
      entries.push(rowToKnowledgeEntry(row));
      store.knowledge.set(row.team_id, entries);
    }

    // Load career events
    const eventRows = rawDb
      .prepare<[], CareerEventRow>(
        "SELECT * FROM career_events ORDER BY timestamp ASC",
      )
      .all();
    for (const row of eventRows) {
      const events = store.careerEvents.get(row.agent_id) ?? [];
      events.push(rowToCareerEvent(row));
      store.careerEvents.set(row.agent_id, events);
    }

    return store;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private _ensureSkillProfile(agentId: string): SkillProfile {
    let profile = this.skillProfiles.get(agentId);
    if (!profile) {
      profile = { agentId, skills: {} };
      this.skillProfiles.set(agentId, profile);
    }
    return profile;
  }

  /**
   * Recompute and persist performance metrics from in-memory task history.
   */
  private _updatePerformanceMetrics(agentId: string): void {
    if (!this.db) return;

    const history = this.taskHistories.get(agentId) ?? [];
    if (history.length === 0) return;

    const tasksCompleted = history.length;
    const successes = history.filter((m) => m.outcome === "success").length;
    const successRate = successes / tasksCompleted;

    const durations = history
      .map((m) => m.tokensUsed) // proxy; real duration stored separately
      .filter((d): d is number => typeof d === "number" && d > 0);
    const avgTaskDuration =
      durations.length > 0
        ? durations.reduce((a, b) => a + b, 0) / durations.length
        : 0;

    this.db.getDb().prepare<[number, number, number, string]>(`
      UPDATE agent_careers
      SET tasks_completed = ?,
          success_rate     = ?,
          avg_task_duration = ?,
          updated_at       = datetime('now')
      WHERE agent_id = ?
    `).run(tasksCompleted, successRate, avgTaskDuration, agentId);
  }
}
