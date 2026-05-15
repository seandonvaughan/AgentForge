/**
 * safe-join.ts — Path containment utility
 *
 * Centralises the safeJoin pattern already used in routes/v5/cycles.ts so that
 * every route that builds file paths from user-supplied identifiers can apply
 * the same containment check without duplicating logic.
 *
 * Usage:
 *   import { safeJoin } from '../../lib/safe-join.js';
 *
 *   const filePath = safeJoin(agentsDir, `${agentId}.yaml`);
 *   if (!filePath) return reply.status(400).send({ error: 'Invalid agent id' });
 */

import { join, resolve, sep } from 'node:path';

/**
 * Resolve `parts` relative to `base` and ensure the result stays inside `base`.
 *
 * Returns the resolved absolute path on success, or `null` if the resolved
 * path would escape `base` (e.g. via `../` sequences or symlink tricks).
 *
 * @example
 *   safeJoin('/project/.agentforge/agents', 'my-agent.yaml')
 *   // → '/project/.agentforge/agents/my-agent.yaml'
 *
 *   safeJoin('/project/.agentforge/agents', '../../etc/passwd')
 *   // → null
 */
export function safeJoin(base: string, ...parts: string[]): string | null {
  const resolved = resolve(join(base, ...parts));
  const baseWithSep = base.endsWith(sep) ? base : base + sep;
  if (resolved !== base && !resolved.startsWith(baseWithSep)) return null;
  return resolved;
}
