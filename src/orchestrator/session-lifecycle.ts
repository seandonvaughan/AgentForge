// src/orchestrator/session-lifecycle.ts
import type { TeamModeState } from "../types/team-mode.js";

type TransitionListener = (from: TeamModeState, to: TeamModeState) => void;

const VALID_TRANSITIONS: Record<TeamModeState, TeamModeState[]> = {
  inactive: ["activating"],
  activating: ["active"],
  active: ["hibernating", "deactivating"],
  hibernating: ["hibernated"],
  hibernated: ["activating"],
  deactivating: ["inactive"],
};

export class SessionLifecycle {
  private state: TeamModeState = "inactive";
  private listeners: TransitionListener[] = [];

  getState(): TeamModeState {
    return this.state;
  }

  transition(to: TeamModeState): void {
    const allowed = VALID_TRANSITIONS[this.state];
    if (!allowed.includes(to)) {
      throw new Error(
        `Invalid lifecycle transition: ${this.state} -> ${to}. Allowed: ${allowed.join(", ")}`
      );
    }
    const from = this.state;
    this.state = to;
    for (const listener of this.listeners) {
      listener(from, to);
    }
  }

  isActive(): boolean {
    return this.state === "active";
  }

  isHibernated(): boolean {
    return this.state === "hibernated";
  }

  canAcceptTasks(): boolean {
    return this.state === "active";
  }

  onTransition(listener: TransitionListener): void {
    this.listeners.push(listener);
  }
}