import { generateId, nowIso } from '@agentforge/shared';
import type { FeatureFlag, CreateFlagRequest, UpdateFlagRequest, FlagStatus } from './types.js';

/**
 * FeatureFlag — manages individual feature flag lifecycle.
 */
export class FeatureFlagManager {
  private flags = new Map<string, FeatureFlag>();

  create(req: CreateFlagRequest): FeatureFlag {
    const flag: FeatureFlag = {
      id: generateId(),
      name: req.name,
      description: req.description,
      status: 'inactive',
      trafficPercent: req.trafficPercent ?? 0,
      strategy: req.strategy ?? 'percentage',
      rollbackThreshold: req.rollbackThreshold ?? 0.05, // 5% default
      errorRate: 0,
      canaryRequests: 0,
      canaryErrors: 0,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.flags.set(flag.id, flag);
    return flag;
  }

  get(id: string): FeatureFlag | undefined {
    return this.flags.get(id);
  }

  getByName(name: string): FeatureFlag | undefined {
    return [...this.flags.values()].find(f => f.name === name);
  }

  list(status?: FlagStatus): FeatureFlag[] {
    const all = [...this.flags.values()];
    if (status) return all.filter(f => f.status === status);
    return all;
  }

  update(id: string, updates: UpdateFlagRequest): FeatureFlag | undefined {
    const flag = this.flags.get(id);
    if (!flag) return undefined;

    const updated: FeatureFlag = {
      ...flag,
      ...(updates.trafficPercent !== undefined && { trafficPercent: Math.min(100, Math.max(0, updates.trafficPercent)) }),
      ...(updates.status !== undefined && { status: updates.status }),
      ...(updates.rollbackThreshold !== undefined && { rollbackThreshold: updates.rollbackThreshold }),
      updatedAt: nowIso(),
    };
    this.flags.set(id, updated);
    return updated;
  }

  activate(id: string): FeatureFlag | undefined {
    return this.update(id, { status: 'active' });
  }

  deactivate(id: string): FeatureFlag | undefined {
    return this.update(id, { status: 'inactive' });
  }

  recordCanaryRequest(id: string, isError: boolean): FeatureFlag | undefined {
    const flag = this.flags.get(id);
    if (!flag) return undefined;

    const canaryRequests = flag.canaryRequests + 1;
    const canaryErrors = flag.canaryErrors + (isError ? 1 : 0);
    const errorRate = canaryRequests > 0 ? canaryErrors / canaryRequests : 0;

    const updated: FeatureFlag = {
      ...flag,
      canaryRequests,
      canaryErrors,
      errorRate,
      updatedAt: nowIso(),
    };
    this.flags.set(id, updated);
    return updated;
  }

  markRolledBack(id: string, reason: string): FeatureFlag | undefined {
    const flag = this.flags.get(id);
    if (!flag) return undefined;

    const updated: FeatureFlag = {
      ...flag,
      status: 'rolled_back',
      trafficPercent: 0,
      rolledBackAt: nowIso(),
      rollbackReason: reason,
      updatedAt: nowIso(),
    };
    this.flags.set(id, updated);
    return updated;
  }

  delete(id: string): boolean {
    return this.flags.delete(id);
  }

  count(): number {
    return this.flags.size;
  }
}
