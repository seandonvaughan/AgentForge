import { writable, readable } from 'svelte/store';
import type { Session } from '$stores/sessions.js';

type WsStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

const RECONNECT_DELAY_MS = 3000;
const MAX_MESSAGES = 200;
const WS_URL = 'ws://127.0.0.1:4750/api/v5/ws';
const SUBSCRIBE_TOPICS = ['agent.*', 'session.*', 'system.*'];

// Public stores
export const wsMessages = writable<unknown[]>([]);

const statusStore = writable<WsStatus>('disconnected');
let _statusUnsub: (() => void) | undefined;

// wsConnected is defined after statusStore so the subscription closure is valid
export const wsConnected = readable<boolean>(false, set => {
  _statusUnsub = statusStore.subscribe(s => set(s === 'connected'));
  return () => { if (_statusUnsub) _statusUnsub(); };
});

function createWsStore() {
  const { subscribe, update } = writable<{ status: WsStatus; events: unknown[] }>({
    status: 'disconnected',
    events: [],
  });

  let ws: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let destroyed = false;

  function clearReconnect() {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function scheduleReconnect() {
    clearReconnect();
    if (destroyed) return;
    reconnectTimer = setTimeout(() => {
      if (!destroyed) connect();
    }, RECONNECT_DELAY_MS);
  }

  function connect() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

    const newStatus = (s: WsStatus) => {
      update(state => ({ ...state, status: s }));
      statusStore.set(s);
    };

    newStatus('connecting');
    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      newStatus('connected');
      ws?.send(JSON.stringify({ type: 'subscribe', topics: SUBSCRIBE_TOPICS }));
    };

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data as string);

        // Append to messages list
        wsMessages.update(msgs => [msg, ...msgs].slice(0, MAX_MESSAGES));
        update(state => ({
          ...state,
          events: [msg, ...state.events].slice(0, MAX_MESSAGES),
        }));

        // Dispatch to relevant stores based on event type
        dispatchWsEvent(msg);
      } catch { /* ignore malformed messages */ }
    };

    ws.onclose = () => {
      newStatus('disconnected');
      scheduleReconnect();
    };

    ws.onerror = () => {
      newStatus('error');
      ws?.close();
    };
  }

  function disconnect() {
    destroyed = true;
    clearReconnect();
    ws?.close();
    ws = null;
    update(s => ({ ...s, status: 'disconnected' }));
    statusStore.set('disconnected');
  }

  function reconnect() {
    destroyed = false;
    disconnect();
    destroyed = false;
    connect();
  }

  return { subscribe, connect, disconnect, reconnect };
}

// ---------------------------------------------------------------------------
// Dispatch incoming WS events to the relevant Svelte stores
// Uses dynamic import to avoid circular imports at module load time.
// ---------------------------------------------------------------------------
async function dispatchWsEvent(msg: unknown) {
  if (!msg || typeof msg !== 'object') return;
  const event = msg as Record<string, unknown>;
  const type = event.type as string | undefined;
  if (!type) return;

  if (type.startsWith('session.')) {
    const { sessions, loadSessions } = await import('$stores/sessions.js');
    const payload = event.data ?? event.payload;

    if (type === 'session.completed' || type === 'session.failed') {
      // Update the existing session in the store, or prepend it
      sessions.update(list => {
        const s = payload as Session;
        const idx = list.findIndex(x => x.id === s?.id);
        if (idx >= 0) {
          const next = [...list];
          next[idx] = { ...next[idx], ...s };
          return next;
        }
        return s?.id ? [s, ...list] : list;
      });
    } else if (type === 'session.started') {
      sessions.update(list => {
        const s = payload as Session;
        if (!s?.id) return list;
        // Prepend only if not already present
        return list.find(x => x.id === s.id) ? list : [s, ...list];
      });
    } else if (type === 'session.refresh') {
      // Server signals a full reload is needed
      await loadSessions({ limit: 100 });
    }
  } else if (type.startsWith('agent.')) {
    const { agents, loadAgents } = await import('$stores/agents.js');
    if (type === 'agent.registered' || type === 'agent.updated') {
      const a = (event.data ?? event.payload) as import('$stores/agents.js').Agent;
      if (a?.agentId) {
        agents.update(list => {
          const idx = list.findIndex(x => x.agentId === a.agentId);
          if (idx >= 0) {
            const next = [...list];
            next[idx] = { ...next[idx], ...a };
            return next;
          }
          return [...list, a];
        });
      }
    } else if (type === 'agent.refresh') {
      await loadAgents();
    }
  } else if (type.startsWith('cost.') || type === 'system.cost_refresh') {
    const { loadCosts } = await import('$stores/costs.js');
    await loadCosts();
  }
}

export const wsStore = createWsStore();
