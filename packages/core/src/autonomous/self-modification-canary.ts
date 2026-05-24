import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { CanaryManager } from '../canary/canary-manager.js';
import type { TrafficSplitResult, TrafficSplitStrategy } from '../canary/types.js';
import { writeFileAtomic } from '../team/engine/fs/atomic-write.js';
import type { MutatorReport } from './auto-reforge.js';

const LEARNINGS_CAP = 12;
const DEFAULT_MIN_CANARY_REQUESTS = 5;

export interface SelfModificationCanaryPolicy {
  enabled: boolean;
  trafficPercent: number;
  strategy: TrafficSplitStrategy;
  rollbackThreshold: number;
  minCanaryRequests: number;
  promoteAfterHealthyRequests: number;
}

export const DEFAULT_SELF_MODIFICATION_CANARY_POLICY: SelfModificationCanaryPolicy = Object.freeze({
  enabled: true,
  trafficPercent: 10,
  strategy: 'hash',
  rollbackThreshold: 0.1,
  minCanaryRequests: DEFAULT_MIN_CANARY_REQUESTS,
  promoteAfterHealthyRequests: 20,
});

export interface SelfModificationCanaryMetrics {
  canaryRequests: number;
  canaryErrors: number;
  errorRate: number;
}

export interface SelfModificationCanaryRollback {
  reason: string;
  errorRate: number;
  threshold: number;
  rolledBackAt: string;
}

export interface SelfModificationCanaryDeployment {
  agentId: string;
  cycleId: string;
  flagId: string;
  stagedAt: string;
  trafficPercent: number;
  strategy: TrafficSplitStrategy;
  rollbackThreshold: number;
  minCanaryRequests: number;
  promoteAfterHealthyRequests: number;
  lessons: string[];
  metrics: SelfModificationCanaryMetrics;
  promotedAt?: string;
  rollback?: SelfModificationCanaryRollback;
}

export interface StageSelfModificationCanaryInput {
  cycleId: string;
  report: MutatorReport;
  policy?: Partial<SelfModificationCanaryPolicy>;
}

export interface SelfModificationCanaryResolution {
  deployment: SelfModificationCanaryDeployment;
  route: TrafficSplitResult;
  lessons: string[];
}

export interface SelfModificationCanaryOutcome {
  deployment: SelfModificationCanaryDeployment;
  action: 'kept' | 'promoted' | 'rolled_back';
}

interface AgentYaml {
  learnings?: unknown;
  [key: string]: unknown;
}

export class SelfModificationCanaryManager {
  private readonly canaryManager = new CanaryManager();
  private readonly dir: string;
  private readonly agentsDir: string;

  constructor(private readonly projectRoot: string) {
    this.dir = join(projectRoot, '.agentforge', 'forge', 'self-modification-canaries');
    this.agentsDir = join(projectRoot, '.agentforge', 'agents');
  }

  async stage(input: StageSelfModificationCanaryInput): Promise<SelfModificationCanaryDeployment[]> {
    const policy = normalizePolicy(input.policy);
    if (!policy.enabled) return [];

    await mkdir(this.dir, { recursive: true });
    const deployments: SelfModificationCanaryDeployment[] = [];
    for (const [agentId, summary] of Object.entries(input.report.perAgent)) {
      const lessons = sanitizeLessons(summary.lessons);
      if (lessons.length === 0 || summary.applied <= 0) continue;

      const deployment: SelfModificationCanaryDeployment = {
        agentId,
        cycleId: input.cycleId,
        flagId: `self-modification:${input.cycleId}:${agentId}`,
        stagedAt: new Date().toISOString(),
        trafficPercent: clampPercent(policy.trafficPercent),
        strategy: policy.strategy,
        rollbackThreshold: clampRatio(
          policy.rollbackThreshold,
          DEFAULT_SELF_MODIFICATION_CANARY_POLICY.rollbackThreshold,
        ),
        minCanaryRequests: Math.max(1, Math.floor(policy.minCanaryRequests)),
        promoteAfterHealthyRequests: Math.max(0, Math.floor(policy.promoteAfterHealthyRequests)),
        lessons,
        metrics: emptyMetrics(),
      };

      this.ensureFlag(deployment);
      await this.writeDeployment(deployment);
      deployments.push(deployment);
    }

    return deployments;
  }

  async resolve(
    agentId: string,
    context: { requestId?: string; headerValue?: string } = {},
  ): Promise<SelfModificationCanaryResolution | null> {
    const deployment = await this.loadDeployment(agentId);
    if (!deployment) return null;

    this.ensureFlag(deployment);
    if (!context.requestId && !context.headerValue) {
      return {
        deployment,
        route: {
          flagId: deployment.flagId,
          variant: 'control',
          requestId: '',
          reason: 'No routing context, routing to control',
        },
        lessons: [],
      };
    }

    const requestId = context.requestId ?? context.headerValue!;
    const route = this.canaryManager.route(deployment.flagId, requestId, context.headerValue);
    return {
      deployment,
      route,
      lessons: route.variant === 'canary' ? deployment.lessons : [],
    };
  }

  async recordOutcome(
    agentId: string,
    flagId: string,
    isError: boolean,
  ): Promise<SelfModificationCanaryOutcome | null> {
    const deployment = await this.loadDeployment(agentId);
    if (!deployment || deployment.flagId !== flagId) return null;

    const updated: SelfModificationCanaryDeployment = {
      ...deployment,
      metrics: nextMetrics(deployment.metrics, isError),
    };

    const rollback = shouldRollback(updated)
      ? buildRollback(updated)
      : undefined;
    if (rollback) {
      const rolledBack = { ...updated, rollback };
      await this.writeRollback(rolledBack);
      await this.deleteDeployment(agentId);
      this.canaryManager.performRollback(flagId, rollback.reason);
      return { deployment: rolledBack, action: 'rolled_back' };
    }

    if (shouldPromote(updated)) {
      const promoted = {
        ...updated,
        promotedAt: new Date().toISOString(),
      };
      try {
        await this.promote(promoted);
      } catch (error) {
        const rolledBack = {
          ...updated,
          rollback: buildRollback(
            updated,
            `Auto-rollback: self-modification canary promotion failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
        };
        await this.writeRollback(rolledBack);
        await this.deleteDeployment(agentId);
        this.canaryManager.performRollback(flagId, rolledBack.rollback.reason);
        return { deployment: rolledBack, action: 'rolled_back' };
      }
      await this.writePromoted(promoted);
      await this.deleteDeployment(agentId);
      this.canaryManager.deleteFlag(flagId);
      return { deployment: promoted, action: 'promoted' };
    }

    await this.writeDeployment(updated);
    return { deployment: updated, action: 'kept' };
  }

  private ensureFlag(deployment: SelfModificationCanaryDeployment): void {
    if (this.canaryManager.getFlag(deployment.flagId)) return;
    this.canaryManager.createFlag({
      id: deployment.flagId,
      name: `self-modification:${deployment.agentId}`,
      description: `Auto-reforge learning canary for ${deployment.agentId}`,
      trafficPercent: deployment.trafficPercent,
      strategy: deployment.strategy,
      rollbackThreshold: deployment.rollbackThreshold,
    });
    this.canaryManager.activateFlag(deployment.flagId);
  }

  private async promote(deployment: SelfModificationCanaryDeployment): Promise<void> {
    await mkdir(this.agentsDir, { recursive: true });
    const agentPath = join(this.agentsDir, `${safeFileSegment(deployment.agentId)}.yaml`);
    const data = await this.loadAgentYaml(agentPath);
    const existing = sanitizeLessons(data.learnings);
    data.learnings = mergeLearnings(existing, deployment.lessons);
    const dumped = yaml.dump(data, {
      indent: 2,
      lineWidth: 120,
      noRefs: true,
      sortKeys: false,
    });
    await writeFileAtomic(agentPath, dumped);
  }

  private async loadAgentYaml(agentPath: string): Promise<AgentYaml> {
    const raw = await readFile(agentPath, 'utf8');
    const parsed = yaml.load(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as AgentYaml;
    }
    throw new Error(`Cannot promote self-modification canary into invalid agent YAML: ${agentPath}`);
  }

  private async loadDeployment(agentId: string): Promise<SelfModificationCanaryDeployment | null> {
    try {
      const raw = await readFile(this.deploymentPath(agentId), 'utf8');
      const parsed = JSON.parse(raw) as SelfModificationCanaryDeployment;
      if (parsed.agentId !== agentId || !Array.isArray(parsed.lessons)) return null;
      return {
        ...parsed,
        trafficPercent: clampPercent(parsed.trafficPercent),
        strategy: isTrafficSplitStrategy(parsed.strategy)
          ? parsed.strategy
          : DEFAULT_SELF_MODIFICATION_CANARY_POLICY.strategy,
        rollbackThreshold: clampRatio(
          parsed.rollbackThreshold,
          DEFAULT_SELF_MODIFICATION_CANARY_POLICY.rollbackThreshold,
        ),
        minCanaryRequests: Math.max(1, Math.floor(parsed.minCanaryRequests ?? DEFAULT_MIN_CANARY_REQUESTS)),
        promoteAfterHealthyRequests: Math.max(0, Math.floor(parsed.promoteAfterHealthyRequests ?? 0)),
        lessons: sanitizeLessons(parsed.lessons),
        metrics: normalizeMetrics(parsed.metrics),
      };
    } catch {
      return null;
    }
  }

  private async writeDeployment(deployment: SelfModificationCanaryDeployment): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFileAtomic(this.deploymentPath(deployment.agentId), JSON.stringify(deployment, null, 2));
  }

  private async writeRollback(deployment: SelfModificationCanaryDeployment): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFileAtomic(
      join(this.dir, `${safeFileSegment(deployment.agentId)}.rollback.json`),
      JSON.stringify(deployment, null, 2),
    );
  }

  private async writePromoted(deployment: SelfModificationCanaryDeployment): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFileAtomic(
      join(this.dir, `${safeFileSegment(deployment.agentId)}.promoted.json`),
      JSON.stringify(deployment, null, 2),
    );
  }

  private async deleteDeployment(agentId: string): Promise<void> {
    await rm(this.deploymentPath(agentId), { force: true });
  }

  private deploymentPath(agentId: string): string {
    return join(this.dir, `${safeFileSegment(agentId)}.json`);
  }
}

function normalizePolicy(policy?: Partial<SelfModificationCanaryPolicy>): SelfModificationCanaryPolicy {
  return {
    enabled: policy?.enabled ?? DEFAULT_SELF_MODIFICATION_CANARY_POLICY.enabled,
    trafficPercent: policy?.trafficPercent ?? DEFAULT_SELF_MODIFICATION_CANARY_POLICY.trafficPercent,
    strategy: policy?.strategy ?? DEFAULT_SELF_MODIFICATION_CANARY_POLICY.strategy,
    rollbackThreshold: policy?.rollbackThreshold ?? DEFAULT_SELF_MODIFICATION_CANARY_POLICY.rollbackThreshold,
    minCanaryRequests: policy?.minCanaryRequests ?? DEFAULT_SELF_MODIFICATION_CANARY_POLICY.minCanaryRequests,
    promoteAfterHealthyRequests:
      policy?.promoteAfterHealthyRequests ??
      DEFAULT_SELF_MODIFICATION_CANARY_POLICY.promoteAfterHealthyRequests,
  };
}

function emptyMetrics(): SelfModificationCanaryMetrics {
  return { canaryRequests: 0, canaryErrors: 0, errorRate: 0 };
}

function nextMetrics(current: SelfModificationCanaryMetrics, isError: boolean): SelfModificationCanaryMetrics {
  const canaryRequests = current.canaryRequests + 1;
  const canaryErrors = current.canaryErrors + (isError ? 1 : 0);
  return {
    canaryRequests,
    canaryErrors,
    errorRate: canaryRequests > 0 ? canaryErrors / canaryRequests : 0,
  };
}

function shouldRollback(deployment: SelfModificationCanaryDeployment): boolean {
  return (
    deployment.metrics.canaryRequests >= deployment.minCanaryRequests &&
    deployment.metrics.errorRate > deployment.rollbackThreshold
  );
}

function shouldPromote(deployment: SelfModificationCanaryDeployment): boolean {
  return (
    deployment.promoteAfterHealthyRequests > 0 &&
    deployment.metrics.canaryRequests >= deployment.promoteAfterHealthyRequests &&
    deployment.metrics.errorRate <= deployment.rollbackThreshold
  );
}

function buildRollback(
  deployment: SelfModificationCanaryDeployment,
  reason?: string,
): SelfModificationCanaryRollback {
  return {
    reason: reason ??
      `Auto-rollback: self-modification canary error rate ${(deployment.metrics.errorRate * 100).toFixed(1)}% exceeds threshold ${(deployment.rollbackThreshold * 100).toFixed(1)}%`,
    errorRate: deployment.metrics.errorRate,
    threshold: deployment.rollbackThreshold,
    rolledBackAt: new Date().toISOString(),
  };
}

function sanitizeLessons(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((lesson) => typeof lesson === 'string' ? lesson.trim() : '')
    .filter((lesson) => lesson.length > 0);
}

function mergeLearnings(existing: string[], staged: string[]): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const lesson of [...staged, ...existing]) {
    const key = lesson.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(lesson);
    if (merged.length >= LEARNINGS_CAP) break;
  }
  return merged;
}

function clampPercent(percent: number): number {
  return Math.min(100, Math.max(0, Number.isFinite(percent) ? percent : 0));
}

function clampRatio(value: number, fallback: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : fallback));
}

function normalizeMetrics(value: unknown): SelfModificationCanaryMetrics {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return emptyMetrics();
  const record = value as Partial<SelfModificationCanaryMetrics>;
  const canaryRequests = Number.isFinite(record.canaryRequests)
    ? Math.max(0, Math.floor(record.canaryRequests!))
    : 0;
  const canaryErrors = Number.isFinite(record.canaryErrors)
    ? Math.max(0, Math.min(canaryRequests, Math.floor(record.canaryErrors!)))
    : 0;
  return {
    canaryRequests,
    canaryErrors,
    errorRate: canaryRequests > 0 ? canaryErrors / canaryRequests : 0,
  };
}

function isTrafficSplitStrategy(value: unknown): value is TrafficSplitStrategy {
  return value === 'percentage' || value === 'hash' || value === 'header';
}

function safeFileSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_');
}
