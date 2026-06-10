// packages/core/src/memory/index.ts
//
// Public API surface for the memory module.
// Re-exports the canonical schema, helper functions, and type unions so
// downstream packages and tests can import from '@agentforge/core' instead of
// reaching into internal paths.

export {
  writeMemoryEntry,
  readMemoryEntries,
  type CycleMemoryEntry,
  type ParsedMemoryEntry,
  type WriteMemoryEntryInput,
  type MemoryEntryType,
  type ReviewFindingMetadata,
  type GateVerdictMetadata,
} from './types.js';

export type { SessionMemoryEntry } from './session-memory-manager.js';

export {
  appendAgentMemory,
  readAgentMemory,
  readAgentMemoryFromDir,
  extractLearnedNotes,
  AGENT_MEMORY_MAX_ENTRIES,
  type AgentMemoryEntry,
  type AgentMemoryKind,
  type AppendAgentMemoryInput,
} from './agent-memory.js';
