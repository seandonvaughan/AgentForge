/**
 * FlywheelMonitor — Sprint 5.2b
 *
 * Tracks all 4 flywheel components: meta-learning, graduated autonomy,
 * capability inheritance, velocity acceleration.
 * Reports health status and velocity ratios.
 */

export interface SprintVelocity {
  sprintId: string;
  tasksCompleted: number;
  tasksPlanned: number;
  durationMs: number;
}

export interface FlywheelComponent {
  name: string;
  active: boolean;
  metric: number;
}

export interface FlywheelHealth {
  components: FlywheelComponent[];
  allActive: boolean;
  velocityRatio: number;
  timestamp: string;
}

export class FlywheelMonitor {
  private velocities: SprintVelocity[] = [];
  private insights: string[] = [];
  private promotions: { agentId: string; fromTier: number; toTier: number }[] = [];
  private inheritances: { source: string; target: string; skillId: string }[] = [];

  // ---------------------------------------------------------------------------
  // Recording
  // ---------------------------------------------------------------------------

  recordSprintVelocity(velocity: SprintVelocity): void {
    this.velocities.push({ ...velocity });
  }

  recordInsight(insight: string): void {
    this.insights.push(insight);
  }

  recordPromotionEvent(agentId: string, fromTier: number, toTier: number): void {
    this.promotions.push({ agentId, fromTier, toTier });
  }

  recordInheritanceEvent(source: string, target: string, skillId: string): void {
    this.inheritances.push({ source, target, skillId });
  }

  // ---------------------------------------------------------------------------
  // Query
  // ---------------------------------------------------------------------------

  getVelocities(): SprintVelocity[] {
    return this.velocities.map((v) => ({ ...v }));
  }

  getVelocityRatio(): number {
    if (this.velocities.length < 2) return 1.0;
    const prev = this.velocities[this.velocities.length - 2];
    const curr = this.velocities[this.velocities.length - 1];
    if (prev.tasksCompleted === 0) return 1.0;
    return curr.tasksCompleted / prev.tasksCompleted;
  }

  getInheritanceRate(): number {
    return this.inheritances.length;
  }

  // ---------------------------------------------------------------------------
  // Health
  // ---------------------------------------------------------------------------

  getFlywheelHealth(): FlywheelHealth {
    const velocityRatio = this.getVelocityRatio();

    const components: FlywheelComponent[] = [
      {
        name: "meta-learning",
        active: this.insights.length >= 2,
        metric: this.insights.length,
      },
      {
        name: "graduated-autonomy",
        active: this.promotions.length > 0,
        metric: this.promotions.length,
      },
      {
        name: "capability-inheritance",
        active: this.inheritances.length > 0,
        metric: this.inheritances.length,
      },
      {
        name: "velocity-acceleration",
        active: velocityRatio > 1.0,
        metric: velocityRatio,
      },
    ];

    return {
      components,
      allActive: components.every((c) => c.active),
      velocityRatio,
      timestamp: new Date().toISOString(),
    };
  }
}
