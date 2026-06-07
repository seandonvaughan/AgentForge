import { browser } from '$app/environment';

export interface EpicLiveCostState {
  costsByChildId: Record<string, number>;
  sseConnected: boolean;
  error: string | null;
}

type Subscriber<T> = (value: T) => void;
type Unsubscriber = () => void;

interface StreamEnvelope {
  type?: string;
  data?: Record<string, unknown>;
  payload?: Record<string, unknown>;
  [key: string]: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asCost(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function firstString(records: Record<string, unknown>[], keys: string[]): string | null {
  for (const record of records) {
    for (const key of keys) {
      const value = asString(record[key]);
      if (value !== null) return value;
    }
  }
  return null;
}

function firstCost(records: Record<string, unknown>[], keys: string[]): number | null {
  for (const record of records) {
    for (const key of keys) {
      const value = asCost(record[key]);
      if (value !== null) return value;
    }
  }
  return null;
}

function collectRecords(envelope: StreamEnvelope): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [envelope];
  for (const root of [envelope.payload, envelope.data]) {
    const record = asRecord(root);
    if (!record) continue;
    records.push(record);
    const nestedPayload = asRecord(record.payload);
    if (nestedPayload) records.push(nestedPayload);
    const nestedData = asRecord(record.data);
    if (nestedData) records.push(nestedData);
  }
  return records;
}

function costMapFromRecord(record: Record<string, unknown>): Record<string, number> {
  const updates: Record<string, number> = {};
  for (const key of ['costsByChildId', 'costByChildId', 'childCosts']) {
    const raw = asRecord(record[key]);
    if (!raw) continue;
    for (const [childId, value] of Object.entries(raw)) {
      const costUsd = asCost(value);
      if (childId.length > 0 && costUsd !== null) updates[childId] = costUsd;
    }
  }

  for (const key of ['children', 'items', 'childCosts']) {
    const raw = record[key];
    if (!Array.isArray(raw)) continue;
    for (const entry of raw) {
      const child = asRecord(entry);
      if (!child) continue;
      const childId = firstString([child], ['childId', 'child_id', 'itemId', 'item_id', 'sprintItemId', 'sprint_item_id', 'id']);
      const costUsd = firstCost([child], ['costUsd', 'cost_usd', 'totalCostUsd', 'total_cost_usd']);
      if (childId !== null && costUsd !== null) updates[childId] = costUsd;
    }
  }
  return updates;
}

export function extractEpicChildCostUpdates(envelope: StreamEnvelope): Record<string, number> {
  const records = collectRecords(envelope);
  const updates: Record<string, number> = {};

  for (const record of records) {
    Object.assign(updates, costMapFromRecord(record));
  }

  const childId = firstString(records, ['childId', 'child_id', 'itemId', 'item_id', 'sprintItemId', 'sprint_item_id']);
  const costUsd = firstCost(records, ['costUsd', 'cost_usd', 'totalCostUsd', 'total_cost_usd']);
  if (childId !== null && costUsd !== null) updates[childId] = costUsd;

  return updates;
}

export function createEpicLiveCostStore(url = '/api/v5/stream') {
  let costsByChildId = $state<Record<string, number>>({});
  let sseConnected = $state(false);
  let error = $state<string | null>(null);
  let source: EventSource | null = null;
  const subscribers = new Set<Subscriber<EpicLiveCostState>>();

  function snapshot(): EpicLiveCostState {
    return {
      costsByChildId: { ...costsByChildId },
      sseConnected,
      error,
    };
  }

  function notify(): void {
    const value = snapshot();
    for (const subscriber of subscribers) subscriber(value);
  }

  function setCost(childId: string, costUsd: number): void {
    if (childId.length === 0 || !Number.isFinite(costUsd) || costUsd < 0) return;
    costsByChildId = { ...costsByChildId, [childId]: costUsd };
    notify();
  }

  function applyUpdates(updates: Record<string, number>): void {
    const entries = Object.entries(updates);
    if (entries.length === 0) return;
    costsByChildId = { ...costsByChildId, ...updates };
    notify();
  }

  function updateFromEvent(envelope: StreamEnvelope): void {
    applyUpdates(extractEpicChildCostUpdates(envelope));
  }

  function handleMessage(event: MessageEvent): void {
    try {
      const parsed = JSON.parse(String(event.data)) as StreamEnvelope;
      updateFromEvent(parsed);
    } catch {
      /* Ignore malformed stream messages. */
    }
  }

  function connect(): void {
    if (source !== null) return;
    if (!browser || typeof EventSource === 'undefined') return;

    try {
      source = new EventSource(url);
      source.onopen = () => {
        sseConnected = true;
        error = null;
        notify();
      };
      source.onmessage = handleMessage;
      source.onerror = () => {
        source?.close();
        source = null;
        sseConnected = false;
        error = 'SSE disconnected';
        notify();
      };
    } catch (e) {
      source = null;
      sseConnected = false;
      error = e instanceof Error ? e.message : String(e);
      notify();
    }
  }

  function disconnect(): void {
    source?.close();
    source = null;
    sseConnected = false;
    notify();
  }

  function reset(): void {
    costsByChildId = {};
    error = null;
    notify();
  }

  function getCost(childId: string): number | undefined {
    return costsByChildId[childId];
  }

  function subscribe(run: Subscriber<EpicLiveCostState>): Unsubscriber {
    subscribers.add(run);
    run(snapshot());
    if (subscribers.size === 1) connect();

    return () => {
      subscribers.delete(run);
      if (subscribers.size === 0) disconnect();
    };
  }

  return {
    subscribe,
    connect,
    disconnect,
    reset,
    setCost,
    updateFromEvent,
    getCost,
    get costsByChildId() {
      return costsByChildId;
    },
    get sseConnected() {
      return sseConnected;
    },
    get error() {
      return error;
    },
  };
}

export const epicLiveCostStore = createEpicLiveCostStore();
export const epicLiveCost = epicLiveCostStore;
