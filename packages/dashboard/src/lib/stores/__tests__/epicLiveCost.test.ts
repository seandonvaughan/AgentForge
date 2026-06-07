import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';

vi.mock('$app/environment', () => ({
  browser: true,
  building: false,
  dev: true,
  version: 'test',
}));

import { createEpicLiveCostStore, extractEpicChildCostUpdates } from '../epicLiveCost.svelte.js';

class MockEventSource {
  static instances: MockEventSource[] = [];

  url: string;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closed = false;

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  close(): void {
    this.closed = true;
  }

  open(): void {
    this.onopen?.({ type: 'open' } as Event);
  }

  push(data: unknown): void {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent);
  }

  static reset(): void {
    MockEventSource.instances = [];
  }
}

beforeEach(() => {
  MockEventSource.reset();
  vi.stubGlobal('EventSource', MockEventSource);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('epicLiveCostStore', () => {
  it('subscribes to the cycle SSE stream and publishes the initial state', () => {
    const store = createEpicLiveCostStore();
    const seen: unknown[] = [];

    const unsubscribe = store.subscribe((state) => seen.push(state));

    expect(MockEventSource.instances).toHaveLength(1);
    expect(MockEventSource.instances[0]!.url).toBe('/api/v5/stream');
    expect(get(store)).toEqual({
      costsByChildId: {},
      sseConnected: false,
      error: null,
    });
    expect(seen).toHaveLength(1);

    unsubscribe();
  });

  it('updates live costUsd by child id from SSE payload and data envelopes', () => {
    const store = createEpicLiveCostStore();
    const unsubscribe = store.subscribe(() => undefined);
    const es = MockEventSource.instances[0]!;

    es.open();
    es.push({
      type: 'cost_event',
      payload: { childId: 'child-18', costUsd: 0.125 },
    });
    es.push({
      type: 'cycle_event',
      data: {
        payload: { itemId: 'child-2', totalCostUsd: 0.375 },
      },
    });

    expect(store.getCost('child-18')).toBe(0.125);
    expect(get(store).costsByChildId).toEqual({
      'child-18': 0.125,
      'child-2': 0.375,
    });
    expect(get(store).sseConnected).toBe(true);

    unsubscribe();
  });

  it('updates multiple child costs from map and item-array payloads', () => {
    expect(extractEpicChildCostUpdates({
      type: 'cycle_event',
      payload: {
        costsByChildId: { 'child-1': 0.1 },
        children: [
          { id: 'child-2', costUsd: 0.2 },
          { item_id: 'child-3', total_cost_usd: 0.3 },
        ],
      },
    })).toEqual({
      'child-1': 0.1,
      'child-2': 0.2,
      'child-3': 0.3,
    });
  });

  it('tears down the EventSource when the last subscriber unsubscribes', () => {
    const store = createEpicLiveCostStore();
    const unsubscribeA = store.subscribe(() => undefined);
    const unsubscribeB = store.subscribe(() => undefined);
    const es = MockEventSource.instances[0]!;

    unsubscribeA();
    expect(es.closed).toBe(false);

    unsubscribeB();
    expect(es.closed).toBe(true);
    expect(MockEventSource.instances).toHaveLength(1);
    expect(store.sseConnected).toBe(false);
  });

  it('ignores malformed stream messages without clearing current costs', () => {
    const store = createEpicLiveCostStore();
    const unsubscribe = store.subscribe(() => undefined);
    const es = MockEventSource.instances[0]!;

    store.setCost('child-18', 0.25);
    es.onmessage?.({ data: '{not-json' } as MessageEvent);

    expect(get(store).costsByChildId).toEqual({ 'child-18': 0.25 });

    unsubscribe();
  });
});
