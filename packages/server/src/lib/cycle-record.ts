/**
 * Cycle-record reader — server package re-export.
 *
 * The canonical implementation now lives in @agentforge/shared so both the
 * server and the SvelteKit dashboard can import from a single source without
 * introducing a cross-package dependency on the heavy server package.
 *
 * This file re-exports everything so existing server-side imports continue to
 * resolve without any changes to their import paths.
 */
export { CycleRecord, readCycleRecord } from '@agentforge/shared';
