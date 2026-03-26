/**
 * FlywheelMonitor — Sprint 5.2b + v4.2 P0-4 (persistence)
 *
 * Tracks all 4 flywheel components: meta-learning, graduated autonomy,
 * capability inheritance, velocity acceleration.
 * Reports health status and velocity ratios.
 *
 * v4.2: File-based persistence via save/load + autoSave option.
 *       Uses FileAdapter interface for testability.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import type { V4MessageBus } from "../communication/v4-message-bus.js";

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

/**
 * Pluggable file operations for flywheel persistence.
 */
export interface FlywheelFileAdapter {
  readFile(path: string): string;
  writeFile(path: string, content: string): void;
  fileExists(path: string): boolean;
}

export class RealFlywheelFileAdapter implements FlywheelFileAdapter {
  readFile(path: string): string { return readFileSync(path, "utf-8"); }
  writeFile(path: string, content: string): void { writeFileSync(path, content, "utf-8"); }
  fileExists(path: string): boolean { return existsSync(path); }
}

export class InMemoryFlywheelFileAdapter implements FlywheelFileAdapter {
  files = new Map<string, string>();
  readFile(path: string): string {
    const content = this.files.get(path);
    if (content === undefined) throw new Error(`File not found: ${path}`);
    return content;
  }
  writeFile(path: string, content: string): void { this.files.set(path, content); }
  fileExists(path: string): boolean { return this.files.has(path); }
}

export interface FlywheelMonitorOptions {
  bus?: V4MessageBus;
  autoSavePath?: string;
  fileAdapter?: FlywheelFileAdapter;
}

export interface FlywheelSnapshot {
  velocities: SprintVelocity[];
  insights: string[];
  promotions: { agentId: string; fromTier: number; toTier: number }[];
  inheritances: { source: string; target: string; skillId: string }[];
  savedAt: string;
}

export class FlywheelMonitor {
  private velocities: SprintVelocity[] = [];
  private insights: string[] = [];
  private promotions: { agentId: string; fromTier: number; toTier: number }[] = [];
  private inheritances: { source: string; target: string; skillId: string }[] = [];
  private readonly bus?: V4MessageBus;
  private readonly autoSavePath?: string;
  private readonly fileAdapter: FlywheelFileAdapter;

  constructor(busOrOptions?: V4MessageBus | FlywheelMonitorOptions) {
    if (busOrOptions && typeof busOrOptions === "object" && "publish" in busOrOptions) {
      // Legacy: constructor(bus)
      this.bus = busOrOptions as V4MessageBus;
      this.fileAdapter = new RealFlywheelFileAdapter();
    } else if (busOrOptions && typeof busOrOptions === "object") {
      const opts = busOrOptions as FlywheelMonitorOptions;
      this.bus = opts.bus;
      this.autoSavePath = opts.autoSavePath;
      this.fileAdapter = opts.fileAdapter ?? new RealFlywheelFileAdapter();
    } else {
      this.fileAdapter = new RealFlywheelFileAdapter();
    }
  }

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  save(path: string): void {
    const snapshot: FlywheelSnapshot = {
      velocities: this.velocities.map((v) => ({ ...v })),
      insights: [...this.insights],
      promotions: this.promotions.map((p) => ({ ...p })),
      inheritances: this.inheritances.map((i) => ({ ...i })),
      savedAt: new Date().toISOString(),
    };
    this.fileAdapter.writeFile(path, JSON.stringify(snapshot, null, 2));
  }

  static load(
    path: string,
    busOrOptions?: V4MessageBus | { bus?: V4MessageBus; fileAdapter?: FlywheelFileAdapter },
  ): FlywheelMonitor {
    let bus: V4MessageBus | undefined;
    let fileAdapter: FlywheelFileAdapter;

    if (busOrOptions && typeof busOrOptions === "object" && "publish" in busOrOptions) {
      bus = busOrOptions as V4MessageBus;
      fileAdapter = new RealFlywheelFileAdapter();
    } else if (busOrOptions && typeof busOrOptions === "object") {
      const opts = busOrOptions as { bus?: V4MessageBus; fileAdapter?: FlywheelFileAdapter };
      bus = opts.bus;
      fileAdapter = opts.fileAdapter ?? new RealFlywheelFileAdapter();
    } else {
      fileAdapter = new RealFlywheelFileAdapter();
    }

    if (!fileAdapter.fileExists(path)) {
      return new FlywheelMonitor(bus ? { bus, fileAdapter } : { fileAdapter });
    }

    const raw = fileAdapter.readFile(path);
    const snapshot: FlywheelSnapshot = JSON.parse(raw);

    const monitor = new FlywheelMonitor(bus ? { bus, fileAdapter } : { fileAdapter });
    (monitor as any).velocities = snapshot.velocities ?? [];
    (monitor as any).insights = snapshot.insights ?? [];
    (monitor as any).promotions = snapshot.promotions ?? [];
    (monitor as any).inheritances = snapshot.inheritances ?? [];
    return monitor;
  }

  private maybeAutoSave(): void {
    if (this.autoSavePath) {
      this.save(this.autoSavePath);
    }
  }

  // ---------------------------------------------------------------------------
  // Recording
  // ---------------------------------------------------------------------------

  recordSprintVelocity(velocity: SprintVelocity): void {
    this.velocities.push({ ...velocity });
    this.maybeAutoSave();
  }

  recordInsight(insight: string): void {
    this.insights.push(insight);
    this.maybeAutoSave();
  }

  recordPromotionEvent(agentId: string, fromTier: number, toTier: number): void {
    this.promotions.push({ agentId, fromTier, toTier });
    this.maybeAutoSave();
  }

  recordInheritanceEvent(source: string, target: string, skillId: string): void {
    this.inheritances.push({ source, target, skillId });
    this.maybeAutoSave();
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

    const health: FlywheelHealth = {
      components,
      allActive: components.every((c) => c.active),
      velocityRatio,
      timestamp: new Date().toISOString(),
    };
    if (this.bus) {
      this.bus.publish({
        from: "flywheel-monitor",
        to: "broadcast",
        topic: "flywheel.health.updated",
        category: "status",
        payload: health,
        priority: "normal",
      });
    }
    return health;
  }
}
