/**
 * src/db/index.ts — Public API for AgentForge database module
 */

export { AgentDatabase } from './database.js';
export type { DatabaseOptions, SessionRow } from './database.js';
export { CREATE_TABLES_SQL, CREATE_INDEXES_SQL, ALL_DDL } from './schema.js';
