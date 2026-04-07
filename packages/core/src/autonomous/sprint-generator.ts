// packages/core/src/autonomous/sprint-generator.ts
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { CycleConfig, RankedItem } from './types.js';
import { bumpVersion, determineVersionTier } from './version-bumper.js';

export interface SprintPlan {
  version: string;
  sprintId: string;
  title: string;
  createdAt: string;
  phase: 'planned';
  items: SprintPlanItem[];
  budget: number;
  teamSize: number;
  successCriteria: string[];
  /** v6.7.4 — Explicit record of how the sprint version was chosen. */
  versionDecision?: {
    previousVersion: string;
    nextVersion: string;
    tier: 'major' | 'minor' | 'patch';
    tagsSeen: string[];
    rationale: string;
  };
}

function buildBumpRationale(
  prev: string,
  next: string,
  tier: 'major' | 'minor' | 'patch',
  tags: string[],
): string {
  const unique = Array.from(new Set(tags));
  const reason =
    tier === 'major'
      ? `breaking/architecture/platform tags found (${unique.filter(t => ['breaking','architecture','platform','major-ui','rewrite'].includes(t)).join(', ')})`
      : tier === 'minor'
        ? unique.some(t => ['feature','capability','enhancement','new'].includes(t))
          ? `feature/capability tags found (${unique.filter(t => ['feature','capability','enhancement','new'].includes(t)).join(', ')})`
          : 'no patch-only or breaking tags — autonomous default is minor'
        : `only patch-level tags (${unique.filter(t => ['fix','bug','security','patch','chore','docs','refactor'].includes(t)).join(', ')})`;
  return `${prev} → ${next} (${tier} bump — ${reason})`;
}

export interface SprintPlanItem {
  id: string;
  title: string;
  description: string;
  priority: 'P0' | 'P1' | 'P2';
  assignee: string;
  status: 'planned';
  estimatedCostUsd: number;
  tags: string[];
  source?: string;
  /** v6.6.0 — Optional list of files (paths or globs) this item is expected
   *  to touch. Used by the execute phase's FileLockManager to serialize
   *  items that would race on the same file. */
  files?: string[];
}

const DEFAULT_STARTING_VERSION = '6.4.0';

export class SprintGenerator {
  constructor(
    private readonly cwd: string,
    private readonly config: CycleConfig,
  ) {}

  async generate(approvedItems: RankedItem[]): Promise<SprintPlan> {
    const currentVersion = this.findLatestSprintVersion();
    const allTags = approvedItems.flatMap(i => i.suggestedTags);
    const tier = determineVersionTier(allTags);
    const nextVersion = bumpVersion(currentVersion, allTags);

    const maxItems = this.config.limits.maxItemsPerSprint;
    const selected = approvedItems.slice(0, maxItems);

    const plan: SprintPlan = {
      version: nextVersion,
      sprintId: `v${nextVersion.replace(/\./g, '-')}-autonomous`,
      title: `AgentForge v${nextVersion} — Autonomous Cycle`,
      createdAt: new Date().toISOString(),
      phase: 'planned',
      items: selected.map(item => this.toSprintItem(item)),
      budget: this.config.budget.perCycleUsd,
      teamSize: Math.max(1, new Set(selected.map(i => i.suggestedAssignee)).size),
      successCriteria: [
        'All sprint items completed',
        `Test pass rate >= ${(this.config.quality.testPassRateFloor * 100).toFixed(0)}%`,
        `Total cost <= $${this.config.budget.perCycleUsd}`,
      ],
      versionDecision: {
        previousVersion: currentVersion,
        nextVersion,
        tier,
        tagsSeen: Array.from(new Set(allTags)),
        rationale: buildBumpRationale(currentVersion, nextVersion, tier, allTags),
      },
    };

    const wrapper = { sprints: [plan] };
    const sprintPath = join(this.cwd, '.agentforge/sprints', `v${nextVersion}.json`);
    writeFileSync(sprintPath, JSON.stringify(wrapper, null, 2));

    return plan;
  }

  private toSprintItem(item: RankedItem): SprintPlanItem {
    return {
      id: item.itemId,
      title: item.title,
      description: item.rationale,
      priority: this.rankToPriority(item.rank),
      assignee: item.suggestedAssignee,
      status: 'planned',
      estimatedCostUsd: item.estimatedCostUsd,
      tags: item.suggestedTags,
    };
  }

  private rankToPriority(rank: number): 'P0' | 'P1' | 'P2' {
    if (rank <= 3) return 'P0';
    if (rank <= 8) return 'P1';
    return 'P2';
  }

  private findLatestSprintVersion(): string {
    const candidates: string[] = [];

    // Candidate 1: the max version found in .agentforge/sprints/
    const sprintsDir = join(this.cwd, '.agentforge/sprints');
    if (existsSync(sprintsDir)) {
      const files = readdirSync(sprintsDir)
        .filter(f => f.startsWith('v') && f.endsWith('.json'));
      for (const f of files) {
        const v = f.slice(1, -5);
        if (/^\d+(\.\d+)*$/.test(v)) candidates.push(v);
      }
    }

    // Candidate 2: the root package.json version — authoritative for the
    // shipped code. Without this the cycle would pick stale sprint files
    // (e.g. v6.4.0) even when the code is at v6.7.3, producing wrong
    // sprint versions that don't reflect what's actually being shipped.
    try {
      const pkgPath = join(this.cwd, 'package.json');
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
        if (typeof pkg.version === 'string' && /^\d+(\.\d+)*$/.test(pkg.version)) {
          candidates.push(pkg.version);
        }
      }
    } catch { /* ignore */ }

    if (candidates.length === 0) return DEFAULT_STARTING_VERSION;

    const sorted = candidates
      .map(v => ({ raw: v, parts: padVersion(v) }))
      .sort((a, b) => compareVersions(b.parts, a.parts)); // descending
    return sorted[0]?.raw ?? DEFAULT_STARTING_VERSION;
  }
}

function padVersion(v: string): [number, number, number] {
  const parts = v.split('.').map(Number);
  while (parts.length < 3) parts.push(0);
  return [parts[0]!, parts[1]!, parts[2]!];
}

function compareVersions(a: [number, number, number], b: [number, number, number]): number {
  if (a[0] !== b[0]) return a[0] - b[0];
  if (a[1] !== b[1]) return a[1] - b[1];
  return a[2] - b[2];
}
