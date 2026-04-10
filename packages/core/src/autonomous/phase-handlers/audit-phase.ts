// packages/core/src/autonomous/phase-handlers/audit-phase.ts
//
// v6.5.2 — Real audit phase handler. Dispatches the researcher agent to
// scan the repo and produce an executive summary + findings list.
//
// v6.8.0 — Injects recent memory entries (gate-verdicts, review-findings,
// cycle-outcomes) into the prompt so the agent benefits from cross-cycle
// learning. Reads from .agentforge/memory/*.jsonl — gracefully no-ops when
// the directory is absent (first cycle or write-phase not yet run).

import { writeFileSync, mkdirSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { PhaseContext, PhaseResult } from '../phase-scheduler.js';
import type { CycleMemoryEntry } from '../../memory/types.js';

export const AUDIT_PHASE_DEFAULT_TOOLS = ['Read', 'Bash', 'Glob', 'Grep'];

// Re-export so existing consumers of audit-phase continue to resolve the type.
export type { CycleMemoryEntry };

export interface AuditPhaseOptions {
  allowedTools?: string[];
  agentId?: string;
  /** Max entries to inject per type. Defaults to 10. */
  memoryLimit?: number;
}

export function makeAuditPhaseHandler(options: AuditPhaseOptions = {}) {
  return (ctx: PhaseContext) => runAuditPhase(ctx, options);
}

/**
 * Read recent memory entries from .agentforge/memory/*.jsonl.
 * Returns entries sorted newest-first, capped at `limit` per type.
 * Silently returns [] when the directory or files are absent.
 */
export function readRecentMemoryEntries(
  projectRoot: string,
  limit = 10,
): CycleMemoryEntry[] {
  const memoryDir = join(projectRoot, '.agentforge', 'memory');
  if (!existsSync(memoryDir)) return [];

  const entries: CycleMemoryEntry[] = [];
  let files: string[];
  try {
    files = readdirSync(memoryDir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return [];
  }

  for (const file of files) {
    try {
      const raw = readFileSync(join(memoryDir, file), 'utf8');
      const fileEntries: CycleMemoryEntry[] = [];
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed) as CycleMemoryEntry;
          if (parsed && typeof parsed === 'object' && parsed.type && parsed.value) {
            fileEntries.push(parsed);
          }
        } catch {
          // skip malformed lines
        }
      }
      // newest first, capped per file/type
      fileEntries.sort((a, b) =>
        (b.createdAt ?? '').localeCompare(a.createdAt ?? ''),
      );
      entries.push(...fileEntries.slice(0, limit));
    } catch {
      // skip unreadable files
    }
  }

  // Final sort newest-first across all types
  entries.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
  return entries;
}

/**
 * Format a list of memory entries as a markdown section for prompt injection.
 * Returns an empty string when there are no entries.
 */
export function formatMemoryForPrompt(entries: CycleMemoryEntry[]): string {
  if (entries.length === 0) return '';

  const byType: Record<string, CycleMemoryEntry[]> = {};
  for (const e of entries) {
    (byType[e.type] ??= []).push(e);
  }

  const sections: string[] = [];
  const typeLabels: Record<string, string> = {
    'gate-verdict': 'Gate verdicts (recent APPROVE/REJECT decisions)',
    'review-finding': 'Code review findings (recurring issues)',
    'cycle-outcome': 'Cycle outcomes (cost, tests, PR status)',
    'failure-pattern': 'Known failure patterns',
    'learned-fact': 'Learned facts',
  };

  for (const [type, typeEntries] of Object.entries(byType)) {
    const label = typeLabels[type] ?? type;
    const bullets = typeEntries
      .slice(0, 5)
      .map((e) => {
        const source = e.source ? ` _(${e.source})_` : '';
        return `- ${e.value}${source}`;
      })
      .join('\n');
    sections.push(`### ${label}\n${bullets}`);
  }

  return `## Past mistakes and learnings (cross-cycle memory)\n\n${sections.join('\n\n')}`;
}

export async function runAuditPhase(
  ctx: PhaseContext,
  options: AuditPhaseOptions = {},
): Promise<PhaseResult> {
  const phase = 'audit' as const;
  const startedAt = Date.now();
  const allowedTools = options.allowedTools ?? AUDIT_PHASE_DEFAULT_TOOLS;
  const agentId = options.agentId ?? 'researcher';
  const memoryLimit = options.memoryLimit ?? 10;

  ctx.bus.publish('sprint.phase.started', {
    sprintId: ctx.sprintId,
    phase,
    cycleId: ctx.cycleId,
    startedAt: new Date(startedAt).toISOString(),
  });

  // Inject cross-cycle memory so the agent doesn't repeat past mistakes.
  const memoryEntries = readRecentMemoryEntries(ctx.projectRoot, memoryLimit);
  const memorySection = formatMemoryForPrompt(memoryEntries);
  const memoryBlock = memorySection
    ? `\n\n${memorySection}\n\nUse the above learnings to highlight recurring issues and avoid patterns that caused previous cycles to fail or be costly.\n`
    : '';

  const task = `You are auditing the AgentForge repository at ${ctx.projectRoot} at the start of sprint v${ctx.sprintVersion}.
${memoryBlock}
Use Read/Glob/Grep/Bash to scan the codebase. Identify:
1. Recent commits (git log --oneline -20)
2. Files with TODO(autonomous) / FIXME(autonomous) markers
3. Tests that are failing (look at recent test output if available)
4. Any cost/performance concerns in the autonomous cycle logs

Produce a 1-paragraph executive summary + a bulleted list of 5-10 concrete findings that should inform sprint planning. Format as markdown.`;

  let findings = '';
  let costUsd = 0;
  let status: PhaseResult['status'] = 'completed';
  let error: string | undefined;

  try {
    const result = await ctx.runtime.run(agentId, task, { allowedTools });
    findings = typeof result?.output === 'string' ? result.output : '';
    costUsd = typeof result?.costUsd === 'number' ? result.costUsd : 0;
  } catch (err) {
    status = 'failed';
    error = err instanceof Error ? err.message : String(err);
  }

  const durationMs = Date.now() - startedAt;
  const phaseResult: PhaseResult = {
    phase,
    status,
    durationMs,
    costUsd,
    agentRuns: [{ agentId, costUsd, durationMs, response: findings, ...(error ? { error } : {}) }],
    ...(error ? { error } : {}),
  };

  if (ctx.cycleId) {
    const phaseJsonPath = join(
      ctx.projectRoot,
      '.agentforge',
      'cycles',
      ctx.cycleId,
      'phases',
      'audit.json',
    );
    try {
      mkdirSync(dirname(phaseJsonPath), { recursive: true });
      writeFileSync(
        phaseJsonPath,
        JSON.stringify(
          {
            phase,
            sprintId: ctx.sprintId,
            sprintVersion: ctx.sprintVersion,
            cycleId: ctx.cycleId,
            agentId,
            findings,
            costUsd,
            durationMs,
            startedAt: new Date(startedAt).toISOString(),
            completedAt: new Date().toISOString(),
            // Number of cross-cycle memory entries actually injected into this
            // audit prompt.  Used by computeMemoryStats() (dashboard flywheel) to
            // compute a precise "memory hit rate" — cycles where this is > 0 are
            // ones where past learnings genuinely influenced the plan.
            memoriesInjected: memoryEntries.length,
          },
          null,
          2,
        ),
      );
    } catch {
      // non-fatal
    }
  }

  ctx.bus.publish('sprint.phase.completed', {
    sprintId: ctx.sprintId,
    phase,
    cycleId: ctx.cycleId,
    result: phaseResult,
    completedAt: new Date().toISOString(),
  });

  return phaseResult;
}
