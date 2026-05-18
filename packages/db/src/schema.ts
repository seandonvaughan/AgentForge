// Master DB schema — workspaces, users, auth
export const MASTER_DDL = `
  CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    owner_id TEXT NOT NULL,
    settings_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    name TEXT,
    role TEXT NOT NULL DEFAULT 'member',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS user_workspaces (
    user_id TEXT NOT NULL REFERENCES users(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    role TEXT NOT NULL DEFAULT 'member',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, workspace_id)
  );

  CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    workspace_id TEXT REFERENCES workspaces(id),
    key_hash TEXT UNIQUE NOT NULL,
    scopes TEXT NOT NULL DEFAULT '[]',
    label TEXT,
    last_used_at TEXT,
    expires_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_workspaces_slug ON workspaces(slug);
  CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);
`;

// Workspace DB schema — agents, sessions, costs, feedback, sprints
export const WORKSPACE_DDL = `
  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    agent_id TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    model TEXT NOT NULL,
    team TEXT,
    system_prompt TEXT,
    skills_json TEXT NOT NULL DEFAULT '[]',
    autonomy_tier INTEGER NOT NULL DEFAULT 1,
    yaml_hash TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    parent_session_id TEXT REFERENCES sessions(id),
    task TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'running',
    model TEXT,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    delegation_depth INTEGER NOT NULL DEFAULT 0,
    autonomy_tier INTEGER NOT NULL DEFAULT 1,
    resume_count INTEGER NOT NULL DEFAULT 0,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS costs (
    id TEXT PRIMARY KEY,
    session_id TEXT REFERENCES sessions(id),
    agent_id TEXT NOT NULL,
    model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS feedback (
    id TEXT PRIMARY KEY,
    session_id TEXT REFERENCES sessions(id),
    agent_id TEXT NOT NULL,
    category TEXT NOT NULL,
    message TEXT NOT NULL,
    sentiment TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS decision_events (
    id TEXT PRIMARY KEY,
    session_id TEXT REFERENCES sessions(id),
    agent_id TEXT NOT NULL,
    decision_type TEXT NOT NULL,
    summary TEXT NOT NULL,
    rationale TEXT,
    payload_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS task_outcomes (
    id TEXT PRIMARY KEY,
    session_id TEXT REFERENCES sessions(id),
    agent_id TEXT NOT NULL,
    task TEXT NOT NULL,
    outcome TEXT NOT NULL DEFAULT 'success',
    success INTEGER NOT NULL DEFAULT 1,
    quality_score REAL,
    model TEXT,
    duration_ms INTEGER,
    summary TEXT,
    payload_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS test_observations (
    id TEXT PRIMARY KEY,
    session_id TEXT REFERENCES sessions(id),
    agent_id TEXT,
    run_id TEXT,
    suite TEXT,
    test_name TEXT,
    file_path TEXT,
    status TEXT NOT NULL,
    message TEXT,
    payload_json TEXT NOT NULL DEFAULT '{}',
    observed_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS promotions (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    previous_tier INTEGER NOT NULL,
    new_tier INTEGER NOT NULL,
    promoted INTEGER NOT NULL DEFAULT 0,
    demoted INTEGER NOT NULL DEFAULT 0,
    reason TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sprints (
    id TEXT PRIMARY KEY,
    version TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL,
    phase TEXT NOT NULL DEFAULT 'planning',
    budget_usd REAL,
    team_size INTEGER,
    items_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS kv_store (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS embeddings (
    id TEXT PRIMARY KEY,
    source_type TEXT NOT NULL,
    source_id TEXT NOT NULL,
    content TEXT NOT NULL,
    vector BLOB NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(source_type, source_id)
  );

  CREATE TABLE IF NOT EXISTS agent_scorecards (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    total_sessions INTEGER NOT NULL DEFAULT 0,
    completed_sessions INTEGER NOT NULL DEFAULT 0,
    failed_sessions INTEGER NOT NULL DEFAULT 0,
    total_cost_usd REAL NOT NULL DEFAULT 0,
    total_latency_ms INTEGER NOT NULL DEFAULT 0,
    last_updated TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS runtime_jobs (
    id TEXT PRIMARY KEY,
    session_id TEXT UNIQUE NOT NULL,
    trace_id TEXT UNIQUE NOT NULL,
    agent_id TEXT NOT NULL,
    task TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    model TEXT,
    runtime_mode TEXT,
    provider_kind TEXT,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    error TEXT,
    result_json TEXT NOT NULL DEFAULT '{}',
    cancel_requested INTEGER NOT NULL DEFAULT 0,
    started_at TEXT,
    completed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS runtime_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT UNIQUE NOT NULL,
    job_id TEXT NOT NULL REFERENCES runtime_jobs(id),
    session_id TEXT NOT NULL,
    trace_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    type TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'run',
    message TEXT NOT NULL,
    data_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS git_branches (
    id TEXT PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    agent_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    target_branch TEXT NOT NULL DEFAULT 'main',
    status TEXT NOT NULL DEFAULT 'active',
    review_status TEXT,
    reviewed_by TEXT,
    merged_at TEXT,
    conflict_info TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS git_merge_queue (
    id TEXT PRIMARY KEY,
    branch_id TEXT NOT NULL REFERENCES git_branches(id) ON DELETE CASCADE,
    branch_name TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    priority TEXT NOT NULL DEFAULT 'P1',
    status TEXT NOT NULL DEFAULT 'pending',
    queued_at TEXT NOT NULL DEFAULT (datetime('now')),
    merged_at TEXT,
    block_reason TEXT
  );

  CREATE TABLE IF NOT EXISTS approvals (
    id TEXT PRIMARY KEY,
    proposal_id TEXT NOT NULL,
    proposal_title TEXT NOT NULL,
    execution_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    diff TEXT,
    test_summary_json TEXT,
    impact_summary TEXT NOT NULL,
    submitted_at TEXT NOT NULL,
    reviewed_at TEXT,
    reviewed_by TEXT,
    notes TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_git_branches_status ON git_branches(status);
  CREATE INDEX IF NOT EXISTS idx_git_branches_agent ON git_branches(agent_id);
  CREATE INDEX IF NOT EXISTS idx_git_branches_name ON git_branches(name);
  CREATE INDEX IF NOT EXISTS idx_git_merge_queue_branch ON git_merge_queue(branch_id);
  CREATE INDEX IF NOT EXISTS idx_git_merge_queue_status ON git_merge_queue(status);
  CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);
  CREATE INDEX IF NOT EXISTS idx_approvals_submitted ON approvals(submitted_at);

  CREATE INDEX IF NOT EXISTS idx_scorecards_agent ON agent_scorecards(agent_id);
  CREATE INDEX IF NOT EXISTS idx_runtime_jobs_session ON runtime_jobs(session_id);
  CREATE INDEX IF NOT EXISTS idx_runtime_jobs_trace ON runtime_jobs(trace_id);
  CREATE INDEX IF NOT EXISTS idx_runtime_jobs_agent ON runtime_jobs(agent_id);
  CREATE INDEX IF NOT EXISTS idx_runtime_jobs_status ON runtime_jobs(status);
  CREATE INDEX IF NOT EXISTS idx_runtime_jobs_created ON runtime_jobs(created_at);
  CREATE INDEX IF NOT EXISTS idx_runtime_events_job ON runtime_events(job_id, sequence);
  CREATE INDEX IF NOT EXISTS idx_runtime_events_session ON runtime_events(session_id, sequence);
  CREATE INDEX IF NOT EXISTS idx_runtime_events_trace ON runtime_events(trace_id, sequence);
  CREATE INDEX IF NOT EXISTS idx_runtime_events_type ON runtime_events(type);

  CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(agent_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
  CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at);
  CREATE INDEX IF NOT EXISTS idx_costs_agent ON costs(agent_id);
  CREATE INDEX IF NOT EXISTS idx_costs_created ON costs(created_at);
  CREATE INDEX IF NOT EXISTS idx_feedback_agent ON feedback(agent_id);
  CREATE INDEX IF NOT EXISTS idx_decision_events_session ON decision_events(session_id);
  CREATE INDEX IF NOT EXISTS idx_decision_events_agent ON decision_events(agent_id);
  CREATE INDEX IF NOT EXISTS idx_decision_events_type ON decision_events(decision_type);
  CREATE INDEX IF NOT EXISTS idx_decision_events_created ON decision_events(created_at);
  CREATE INDEX IF NOT EXISTS idx_task_outcomes_session ON task_outcomes(session_id);
  CREATE INDEX IF NOT EXISTS idx_task_outcomes_agent ON task_outcomes(agent_id);
  CREATE INDEX IF NOT EXISTS idx_task_outcomes_outcome ON task_outcomes(outcome);
  CREATE INDEX IF NOT EXISTS idx_task_outcomes_created ON task_outcomes(created_at);
  CREATE INDEX IF NOT EXISTS idx_test_observations_session ON test_observations(session_id);
  CREATE INDEX IF NOT EXISTS idx_test_observations_agent ON test_observations(agent_id);
  CREATE INDEX IF NOT EXISTS idx_test_observations_run ON test_observations(run_id);
  CREATE INDEX IF NOT EXISTS idx_test_observations_status ON test_observations(status);
  CREATE INDEX IF NOT EXISTS idx_test_observations_observed ON test_observations(observed_at);
  CREATE INDEX IF NOT EXISTS idx_embeddings_source ON embeddings(source_type, source_id);

  CREATE TABLE IF NOT EXISTS knowledge_entities (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    source_cycle_id TEXT,
    source_type TEXT NOT NULL DEFAULT 'cycle',
    embedding BLOB,
    properties_json TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS knowledge_relationships (
    id TEXT PRIMARY KEY,
    from_entity_id TEXT NOT NULL REFERENCES knowledge_entities(id) ON DELETE CASCADE,
    to_entity_id TEXT NOT NULL REFERENCES knowledge_entities(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    confidence REAL NOT NULL DEFAULT 0.5,
    properties_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_knowledge_entities_type ON knowledge_entities(type);
  CREATE INDEX IF NOT EXISTS idx_knowledge_entities_name ON knowledge_entities(name);
  CREATE INDEX IF NOT EXISTS idx_knowledge_relationships_from ON knowledge_relationships(from_entity_id);
  CREATE INDEX IF NOT EXISTS idx_knowledge_relationships_to ON knowledge_relationships(to_entity_id);
  CREATE INDEX IF NOT EXISTS idx_knowledge_relationships_type ON knowledge_relationships(type);

  -- Agent direct messages (v1 — see docs/v2-architecture/agent-comm-and-kb-spec.md section 3).
  -- v1 is intentionally narrower than the spec's section 3.2 schema: no thread_id,
  -- no priority, no ttl, no context back-refs. Delivery is via prompt injection
  -- (ADR 0001), so we track delivered_at only — read_at, threading depth, and
  -- soft-delete are deferred to v2.
  CREATE TABLE IF NOT EXISTS direct_messages (
    id            TEXT PRIMARY KEY,
    from_agent    TEXT NOT NULL,
    to_agent      TEXT NOT NULL,
    body          TEXT NOT NULL,
    reply_to_id   TEXT REFERENCES direct_messages(id),
    sent_at       TEXT NOT NULL DEFAULT (datetime('now')),
    delivered_at  TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_direct_messages_recipient ON direct_messages(to_agent, delivered_at);
  CREATE INDEX IF NOT EXISTS idx_direct_messages_sender    ON direct_messages(from_agent, sent_at);
  CREATE INDEX IF NOT EXISTS idx_direct_messages_thread    ON direct_messages(reply_to_id);

  -- Central inbox (v1 — see spec section 4).
  -- v1 limits: '@user' recipient only, no '@team-*' resolution, no FTS5, no
  -- snooze/star. Junction table modelled per ADR 0005 so v2 can add multi-
  -- recipient without schema churn.
  CREATE TABLE IF NOT EXISTS inbox_messages (
    id           TEXT PRIMARY KEY,
    body         TEXT NOT NULL,
    kind         TEXT NOT NULL DEFAULT 'info',
    source_id    TEXT,
    source_type  TEXT,
    thread_id    TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS inbox_recipients (
    message_id  TEXT NOT NULL REFERENCES inbox_messages(id) ON DELETE CASCADE,
    recipient   TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'unread',
    read_at     TEXT,
    PRIMARY KEY (message_id, recipient)
  );
  CREATE INDEX IF NOT EXISTS idx_inbox_messages_created   ON inbox_messages(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_inbox_messages_source    ON inbox_messages(source_type, source_id);
  CREATE INDEX IF NOT EXISTS idx_inbox_recipients_lookup  ON inbox_recipients(recipient, status, message_id);

  -- Knowledge Bases (Subsystem C v1) — see spec section 5.
  -- v1 is intentionally narrower than the spec's section 5.2 schema: no tags,
  -- no pinned flag, no cross-links table, no FTS5 index. Versioning is the
  -- core feature: every update is a new row in kb_doc_versions, never an
  -- in-place mutation of the body. ACL enforcement (read_scope / write_scope)
  -- is deferred to Phase 2; v1 honours visibility only as advisory metadata.
  CREATE TABLE IF NOT EXISTS kbs (
    id          TEXT PRIMARY KEY,
    slug        TEXT UNIQUE NOT NULL,
    title       TEXT NOT NULL,
    description TEXT,
    owner       TEXT NOT NULL,
    visibility  TEXT NOT NULL DEFAULT 'workspace',
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS kb_docs (
    id                   TEXT PRIMARY KEY,
    kb_id                TEXT NOT NULL REFERENCES kbs(id) ON DELETE CASCADE,
    slug                 TEXT NOT NULL,
    title                TEXT NOT NULL,
    current_version_id   TEXT,
    created_at           TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at           TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (kb_id, slug)
  );

  CREATE TABLE IF NOT EXISTS kb_doc_versions (
    id              TEXT PRIMARY KEY,
    doc_id          TEXT NOT NULL REFERENCES kb_docs(id) ON DELETE CASCADE,
    version         INTEGER NOT NULL,
    body_md         TEXT NOT NULL,
    authored_by     TEXT NOT NULL,
    authored_at     TEXT NOT NULL DEFAULT (datetime('now')),
    commit_message  TEXT,
    UNIQUE (doc_id, version)
  );

  CREATE INDEX IF NOT EXISTS idx_kbs_slug             ON kbs(slug);
  CREATE INDEX IF NOT EXISTS idx_kb_docs_kb_id        ON kb_docs(kb_id);
  CREATE INDEX IF NOT EXISTS idx_kb_versions_doc_id   ON kb_doc_versions(doc_id, version DESC);
`;
