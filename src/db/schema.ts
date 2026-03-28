/**
 * Unified SQLite audit schema for AgentForge v4.7
 * P0-1: Core audit tables + P0-7: Delegation chain columns
 */

export const CREATE_TABLES_SQL: string[] = [
  // Core session audit table
  `CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  agent_name TEXT,
  model TEXT,
  task TEXT NOT NULL,
  response TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  started_at TEXT NOT NULL,
  completed_at TEXT,
  estimated_tokens INTEGER,
  autonomy_tier INTEGER DEFAULT 1,
  resume_count INTEGER DEFAULT 0,
  parent_session_id TEXT REFERENCES sessions(id),
  delegation_depth INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`,

  // Feedback entries
  `CREATE TABLE IF NOT EXISTS feedback (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  session_id TEXT REFERENCES sessions(id),
  category TEXT NOT NULL,
  message TEXT NOT NULL,
  sentiment TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`,

  // Task outcomes
  `CREATE TABLE IF NOT EXISTS task_outcomes (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  agent_id TEXT NOT NULL,
  task TEXT NOT NULL,
  success INTEGER NOT NULL DEFAULT 0,
  quality_score REAL,
  model TEXT,
  duration_ms INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`,

  // Tier promotion/demotion events
  `CREATE TABLE IF NOT EXISTS promotions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  previous_tier INTEGER NOT NULL,
  new_tier INTEGER NOT NULL,
  promoted INTEGER NOT NULL DEFAULT 0,
  demoted INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`,

  // Per-session cost tracking
  `CREATE TABLE IF NOT EXISTS agent_costs (
  id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES sessions(id),
  agent_id TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`,

  // Persistent autonomy tier state (P0-8 foundation)
  `CREATE TABLE IF NOT EXISTS agent_autonomy (
  agent_id TEXT PRIMARY KEY,
  current_tier INTEGER NOT NULL DEFAULT 1,
  consecutive_successes INTEGER NOT NULL DEFAULT 0,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  total_successes INTEGER NOT NULL DEFAULT 0,
  total_failures INTEGER NOT NULL DEFAULT 0,
  promoted_at TEXT,
  demoted_at TEXT,
  reason TEXT,
  session_count INTEGER NOT NULL DEFAULT 0,
  success_rate REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
)`,

  // Agent Identity Hub — Phase 1.2 tables

  // Agent career records
  `CREATE TABLE IF NOT EXISTS agent_careers (
  agent_id TEXT PRIMARY KEY,
  hired_at TEXT NOT NULL,
  current_team TEXT NOT NULL,
  current_role TEXT NOT NULL,
  seniority TEXT NOT NULL,
  autonomy_tier INTEGER NOT NULL DEFAULT 1,
  tasks_completed INTEGER DEFAULT 0,
  success_rate REAL DEFAULT 0.0,
  avg_task_duration REAL DEFAULT 0.0,
  peer_review_score REAL DEFAULT 0.0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
)`,

  // Agent skill levels
  `CREATE TABLE IF NOT EXISTS agent_skills (
  agent_id TEXT NOT NULL,
  skill_name TEXT NOT NULL,
  level INTEGER NOT NULL DEFAULT 1,
  exercise_count INTEGER DEFAULT 0,
  success_rate REAL DEFAULT 0.0,
  last_exercised TEXT,
  unlocked_capabilities TEXT,
  PRIMARY KEY (agent_id, skill_name)
)`,

  // Task memories
  `CREATE TABLE IF NOT EXISTS task_memories (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  objective TEXT,
  approach TEXT,
  outcome TEXT NOT NULL,
  lessons_learned TEXT,
  files_modified TEXT,
  collaborators TEXT,
  difficulty INTEGER,
  tokens_used INTEGER
)`,

  // Career events
  `CREATE TABLE IF NOT EXISTS career_events (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  details TEXT,
  timestamp TEXT NOT NULL
)`,

  // Institutional knowledge
  `CREATE TABLE IF NOT EXISTS institutional_knowledge (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  category TEXT NOT NULL,
  content TEXT NOT NULL,
  source TEXT,
  confidence REAL DEFAULT 1.0,
  reference_links TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_validated TEXT
)`,

  // Execution slots
  `CREATE TABLE IF NOT EXISTS execution_slots (
  slot_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  working_files TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT
)`,

  // Teams
  `CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  layer TEXT NOT NULL,
  manager_id TEXT,
  tech_lead_id TEXT,
  max_capacity INTEGER DEFAULT 10,
  domain TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`,

  // Hiring recommendations
  `CREATE TABLE IF NOT EXISTS hiring_recommendations (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  requested_role TEXT NOT NULL,
  requested_seniority TEXT NOT NULL,
  requested_skills TEXT,
  justification TEXT,
  status TEXT DEFAULT 'pending',
  requested_by TEXT,
  decided_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at TEXT
)`,
];

export const CREATE_INDEXES_SQL: string[] = [
  `CREATE INDEX IF NOT EXISTS idx_sessions_created_at ON sessions(created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_agent_id ON sessions(agent_id)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_feedback_created_at ON feedback(created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_task_outcomes_session ON task_outcomes(session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_task_outcomes_created_at ON task_outcomes(created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_agent_costs_session ON agent_costs(session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_agent_costs_created_at ON agent_costs(created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_promotions_agent ON promotions(agent_id)`,
  `CREATE INDEX IF NOT EXISTS idx_promotions_created_at ON promotions(created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_agent_autonomy_updated_at ON agent_autonomy(updated_at)`,

  // Agent Identity Hub indexes
  `CREATE INDEX IF NOT EXISTS idx_agent_careers_current_team ON agent_careers(current_team)`,
  `CREATE INDEX IF NOT EXISTS idx_agent_skills_agent_id ON agent_skills(agent_id)`,
  `CREATE INDEX IF NOT EXISTS idx_task_memories_agent_id ON task_memories(agent_id)`,
  `CREATE INDEX IF NOT EXISTS idx_task_memories_timestamp ON task_memories(timestamp)`,
  `CREATE INDEX IF NOT EXISTS idx_career_events_agent_id ON career_events(agent_id)`,
  `CREATE INDEX IF NOT EXISTS idx_career_events_timestamp ON career_events(timestamp)`,
  `CREATE INDEX IF NOT EXISTS idx_institutional_knowledge_team_id ON institutional_knowledge(team_id)`,
  `CREATE INDEX IF NOT EXISTS idx_execution_slots_agent_id ON execution_slots(agent_id)`,
  `CREATE INDEX IF NOT EXISTS idx_execution_slots_status ON execution_slots(status)`,
  `CREATE INDEX IF NOT EXISTS idx_teams_layer ON teams(layer)`,
  `CREATE INDEX IF NOT EXISTS idx_hiring_recommendations_team_id ON hiring_recommendations(team_id)`,
  `CREATE INDEX IF NOT EXISTS idx_hiring_recommendations_status ON hiring_recommendations(status)`,
];

export const ALL_DDL: string[] = [...CREATE_TABLES_SQL, ...CREATE_INDEXES_SQL];
