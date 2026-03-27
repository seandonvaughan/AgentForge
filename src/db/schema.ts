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
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
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
];

export const ALL_DDL: string[] = [...CREATE_TABLES_SQL, ...CREATE_INDEXES_SQL];
