// packages/core/src/memory/agent-memory.ts
//
// Per-agent personal memory (W2). Each agent accumulates its OWN experience
// in `.agentforge/memory/agents/<agentId>.jsonl`, separate from the shared
// role-filtered pool in `.agentforge/memory/*.jsonl`. Write paths are
// deterministic (execute-phase distills one record per settled item, plus
// optional agent-emitted `LEARNED:` notes); the read path injects the
// agent's own recent history ahead of the shared pool in fresh-context.
//
// Files are bounded: every append compacts to MAX_ENTRIES (dedupe by value,
// most-recent kept), so the store never grows without limit.

import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/** Hard cap per agent file — compaction keeps the most recent entries. */
export const AGENT_MEMORY_MAX_ENTRIES = 200;

export type AgentMemoryKind = 'item-outcome' | 'self-note';

export interface AgentMemoryEntry {
  id: string;
  createdAt: string;
  kind: AgentMemoryKind;
  /** One-line distilled record (item outcome) or the agent's own LEARNED note. */
  value: string;
  cycleId?: string;
  itemId?: string;
  outcome?: 'completed' | 'failed';
  costUsd?: number;
  files?: string[];
  tags?: string[];
}

export interface AppendAgentMemoryInput {
  kind: AgentMemoryKind;
  value: string;
  cycleId?: string | undefined;
  itemId?: string | undefined;
  outcome?: 'completed' | 'failed' | undefined;
  costUsd?: number | undefined;
  files?: string[] | undefined;
  tags?: string[] | undefined;
}

const SAFE_AGENT_ID = /^[a-zA-Z0-9_-]+$/;

/**
 * Match-then-use sanitizer (repo convention): return the REGEX MATCH, never
 * the raw input, so static analyzers (CodeQL js/path-injection) can trace
 * that the joined segment is provably traversal-free.
 */
function safeAgentFileName(agentId: string): string | null {
  const m = SAFE_AGENT_ID.exec(agentId);
  return m ? `${m[0]}.jsonl` : null;
}

function agentMemoryPath(projectRoot: string, agentId: string): string | null {
  const fileName = safeAgentFileName(agentId);
  if (!fileName) return null;
  return join(projectRoot, '.agentforge', 'memory', 'agents', fileName);
}

// Simple exclusive lock mirroring memory/types.ts — O_EXCL create, best-effort.
function acquireLock(lockPath: string): boolean {
  for (let i = 0; i < 5; i++) {
    try {
      closeSync(openSync(lockPath, 'wx'));
      return true;
    } catch {
      // brief sync backoff — lock contention is rare and short-lived
      const until = Date.now() + 10;
      while (Date.now() < until) { /* spin */ }
    }
  }
  return false;
}

function releaseLock(lockPath: string): void {
  try { unlinkSync(lockPath); } catch { /* already gone */ }
}

function parseLines(raw: string): AgentMemoryEntry[] {
  const out: AgentMemoryEntry[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as AgentMemoryEntry;
      if (parsed && typeof parsed.value === 'string' && parsed.value.length > 0) out.push(parsed);
    } catch { /* skip corrupt line */ }
  }
  return out;
}

/**
 * Append one entry to the agent's personal memory file. Non-fatal on any
 * failure (read-only FS, invalid agent id → silently dropped). When the file
 * exceeds AGENT_MEMORY_MAX_ENTRIES the store compacts in place: entries are
 * deduplicated by `value` (latest kept) and trimmed to the most recent cap.
 */
export function appendAgentMemory(
  projectRoot: string,
  agentId: string,
  input: AppendAgentMemoryInput,
): AgentMemoryEntry | null {
  const filePath = agentMemoryPath(projectRoot, agentId);
  if (!filePath) return null;

  const entry: AgentMemoryEntry = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    kind: input.kind,
    value: input.value,
    ...(input.cycleId !== undefined ? { cycleId: input.cycleId } : {}),
    ...(input.itemId !== undefined ? { itemId: input.itemId } : {}),
    ...(input.outcome !== undefined ? { outcome: input.outcome } : {}),
    ...(input.costUsd !== undefined ? { costUsd: input.costUsd } : {}),
    ...(input.files !== undefined && input.files.length > 0 ? { files: input.files } : {}),
    ...(input.tags !== undefined && input.tags.length > 0 ? { tags: input.tags } : {}),
  };

  try {
    mkdirSync(join(projectRoot, '.agentforge', 'memory', 'agents'), { recursive: true });
    const lockPath = filePath + '.lock';
    const locked = acquireLock(lockPath);
    try {
      appendFileSync(filePath, JSON.stringify(entry) + '\n', 'utf8');
      // Compaction rewrites the whole file — only safe with the lock held;
      // an unlocked rewrite could race a concurrent writer and drop entries.
      // (An append without the lock is still an atomic O_APPEND write.)
      if (locked) compactIfNeeded(filePath);
    } finally {
      if (locked) releaseLock(lockPath);
    }
    return entry;
  } catch (err) {
    console.warn(`[agent-memory] failed to append for ${agentId}`, err);
    return null;
  }
}

/** Dedupe-by-value (latest wins) + trim to cap. Called under the append lock. */
function compactIfNeeded(filePath: string): void {
  const raw = readFileSync(filePath, 'utf8');
  const entries = parseLines(raw);
  if (entries.length <= AGENT_MEMORY_MAX_ENTRIES) return;

  const byValue = new Map<string, AgentMemoryEntry>();
  for (const e of entries) {
    // delete-then-set moves re-seen values to the END of insertion order —
    // Map#set alone keeps the FIRST position, so slice(-cap) would wrongly
    // treat a recently re-affirmed note as old and drop it.
    byValue.delete(e.value);
    byValue.set(e.value, e);
  }
  const compacted = [...byValue.values()].slice(-AGENT_MEMORY_MAX_ENTRIES);

  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, compacted.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  renameSync(tmp, filePath);
}

/**
 * Read the agent's most recent personal memory, newest first.
 * Empty array when the file is absent, unreadable, or the id is unsafe.
 */
export function readAgentMemory(
  projectRoot: string,
  agentId: string,
  limit = 5,
): AgentMemoryEntry[] {
  return readAgentMemoryFromDir(join(projectRoot, '.agentforge', 'memory'), agentId, limit);
}

/**
 * Variant keyed on the memory directory itself — fresh-context receives the
 * `.agentforge` dir, not the project root, so it reads via this path.
 */
export function readAgentMemoryFromDir(
  memoryDir: string,
  agentId: string,
  limit = 5,
): AgentMemoryEntry[] {
  const fileName = safeAgentFileName(agentId);
  if (!fileName) return [];
  const filePath = join(memoryDir, 'agents', fileName);
  if (!existsSync(filePath)) return [];
  try {
    return parseLines(readFileSync(filePath, 'utf8')).slice(-limit).reverse();
  } catch {
    return [];
  }
}

/**
 * Extract agent-emitted `LEARNED:` notes from a run's response text.
 * The execute prompt invites agents to record durable, generalisable insight
 * as lines starting with `LEARNED:`; everything else in the response is
 * ignored. Capped to avoid a chatty run flooding the store.
 */
export function extractLearnedNotes(responseText: string, max = 3): string[] {
  const notes: string[] = [];
  for (const line of responseText.split('\n')) {
    const trimmed = line.replace(/^[*-]\s*/, '').trim();
    if (!trimmed.toUpperCase().startsWith('LEARNED:')) continue;
    const note = trimmed.slice('LEARNED:'.length).trim();
    if (note.length >= 10 && note.length <= 500) notes.push(note);
    if (notes.length >= max) break;
  }
  return notes;
}
