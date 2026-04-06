// packages/core/src/autonomous/sprint-generator.ts
import { readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { CycleConfig, RankedItem } from './types.js';
import { bumpVersion } from './version-bumper.js';

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
    const sprintsDir = join(this.cwd, '.agentforge/sprints');
    if (!existsSync(sprintsDir)) return DEFAULT_STARTING_VERSION;

    const files = readdirSync(sprintsDir)
      .filter(f => f.startsWith('v') && f.endsWith('.json'));

    if (files.length === 0) return DEFAULT_STARTING_VERSION;

    const versions = files
      .map(f => f.slice(1, -5)) // strip "v" prefix and ".json" suffix
      .filter(v => /^\d+(\.\d+)*$/.test(v))
      .map(v => ({ raw: v, parts: padVersion(v) }))
      .sort((a, b) => compareVersions(b.parts, a.parts)); // descending

    return versions[0]?.raw ?? DEFAULT_STARTING_VERSION;
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
