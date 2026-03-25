/**
 * Pub-sub event bus for cross-agent broadcasts.
 *
 * Agents subscribe to event types they care about. When a {@link TeamEvent}
 * is published, the bus resolves which subscribers should be notified based
 * on the event's `notify` field and each agent's subscriptions.
 */

import type { TeamEvent } from "../types/orchestration.js";

export class EventBus {
  /** eventType -> Set of agent names subscribed to that type */
  private subscriptions = new Map<string, Set<string>>();

  /**
   * Register an agent to receive events of the given types.
   *
   * Duplicate subscriptions for the same agent + eventType pair are ignored.
   */
  subscribe(agentName: string, eventTypes: string[]): void {
    for (const eventType of eventTypes) {
      let agents = this.subscriptions.get(eventType);
      if (!agents) {
        agents = new Set<string>();
        this.subscriptions.set(eventType, agents);
      }
      agents.add(agentName);
    }
  }

  /**
   * Remove all subscriptions for the given agent across every event type.
   */
  unsubscribe(agentName: string): void {
    for (const agents of this.subscriptions.values()) {
      agents.delete(agentName);
    }
  }

  /**
   * Publish a {@link TeamEvent} and return the list of agent names that
   * were notified.
   *
   * - If `event.notify` contains `"*"`, all agents subscribed to
   *   `event.type` are notified.
   * - Otherwise only agents that appear in **both** `event.notify` and
   *   the subscription set for `event.type` are notified.
   */
  publish(event: TeamEvent): string[] {
    const subscribed = this.subscriptions.get(event.type);
    if (!subscribed || subscribed.size === 0) {
      return [];
    }

    if (event.notify.includes("*")) {
      return [...subscribed];
    }

    return event.notify.filter((agent) => subscribed.has(agent));
  }

  /**
   * Return the names of all agents currently subscribed to the given
   * event type.
   */
  getSubscribers(eventType: string): string[] {
    const agents = this.subscriptions.get(eventType);
    if (!agents) {
      return [];
    }
    return [...agents];
  }
}
