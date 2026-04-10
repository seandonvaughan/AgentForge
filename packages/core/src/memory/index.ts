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
  type MemoryEntryType,
  type ReviewFindingMetadata,
  type GateVerdictMetadata,
} from './types.js';
