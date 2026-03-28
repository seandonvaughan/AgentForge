import type { FeatureFlag, TrafficSplitResult, TrafficSplitStrategy } from './types.js';

/**
 * TrafficSplitter — determines whether a request should be routed to
 * the canary variant or the control variant for a given feature flag.
 */
export class TrafficSplitter {
  /**
   * Determine the variant for a given request.
   * @param flag The feature flag
   * @param requestId A stable identifier for the request (user ID, session ID, etc.)
   * @param headerValue Optional header value for header-based splitting
   */
  split(
    flag: FeatureFlag,
    requestId: string,
    headerValue?: string,
  ): TrafficSplitResult {
    if (flag.status !== 'active') {
      return {
        flagId: flag.id,
        variant: 'control',
        requestId,
        reason: `Flag is ${flag.status}, routing to control`,
      };
    }

    if (flag.trafficPercent <= 0) {
      return {
        flagId: flag.id,
        variant: 'control',
        requestId,
        reason: 'Traffic percent is 0, routing to control',
      };
    }

    if (flag.trafficPercent >= 100) {
      return {
        flagId: flag.id,
        variant: 'canary',
        requestId,
        reason: 'Traffic percent is 100, routing to canary',
      };
    }

    const isCanary = this.computeVariant(flag.strategy, flag.trafficPercent, requestId, headerValue);

    return {
      flagId: flag.id,
      variant: isCanary ? 'canary' : 'control',
      requestId,
      reason: isCanary
        ? `${flag.strategy} split: request in canary bucket (${flag.trafficPercent}%)`
        : `${flag.strategy} split: request in control bucket`,
    };
  }

  private computeVariant(
    strategy: TrafficSplitStrategy,
    trafficPercent: number,
    requestId: string,
    headerValue?: string,
  ): boolean {
    switch (strategy) {
      case 'hash': {
        // Consistent hash ensures same requestId always gets same variant
        const hash = this.simpleHash(requestId);
        return (hash % 100) < trafficPercent;
      }

      case 'header': {
        // If a specific header value indicates canary participation
        if (headerValue) {
          const headerHash = this.simpleHash(headerValue);
          return (headerHash % 100) < trafficPercent;
        }
        // Fall through to percentage if no header
        return Math.random() * 100 < trafficPercent;
      }

      case 'percentage':
      default: {
        return Math.random() * 100 < trafficPercent;
      }
    }
  }

  /**
   * Simple deterministic hash for consistent splitting.
   * Uses djb2 algorithm.
   */
  private simpleHash(str: string): number {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) + hash) + str.charCodeAt(i);
      hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash);
  }

  /**
   * Compute deterministic split result — useful for testing.
   * Returns 0-99 bucket for a given requestId.
   */
  getBucket(requestId: string): number {
    return this.simpleHash(requestId) % 100;
  }
}
