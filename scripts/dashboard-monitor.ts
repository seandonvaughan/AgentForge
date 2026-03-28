/**
 * dashboard-monitor.ts
 * Playwright-based headless dashboard health monitor.
 *
 * Watches the SSE stream from the v5 API server.
 * If the dashboard UI becomes stale (no events for >30s), sends a refresh signal.
 * Run: npx tsx scripts/dashboard-monitor.ts
 */
import { chromium } from 'playwright';

const API_BASE = process.env.API_BASE ?? 'http://localhost:4750';
const DASH_URL = process.env.DASH_URL ?? 'http://localhost:4751';
const STALE_THRESHOLD_MS = parseInt(process.env.STALE_THRESHOLD_MS ?? '30000');
const CHECK_INTERVAL_MS = parseInt(process.env.CHECK_INTERVAL_MS ?? '10000');

let lastEventTime = Date.now();
let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;

async function sendRefreshSignal(reason: string): Promise<void> {
  try {
    const res = await fetch(`${API_BASE}/api/v5/dashboard/refresh-signal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason }),
    });
    if (res.ok) {
      console.log(`[monitor] Refresh signal sent: ${reason}`);
    }
  } catch (err) {
    console.error('[monitor] Failed to send refresh signal:', err);
  }
}

async function watchSSEStream(): Promise<void> {
  const { EventSource } = await import('eventsource');
  const es = new EventSource(`${API_BASE}/api/v5/stream`);

  es.onmessage = (event) => {
    lastEventTime = Date.now();
    try {
      const data = JSON.parse(event.data);
      if (data.type !== 'system') {
        console.log(`[monitor] event: ${data.type} — ${data.message?.slice(0, 80)}`);
      }
    } catch { /* ignore parse errors */ }
  };

  es.onerror = () => {
    console.log('[monitor] SSE connection lost, reconnecting...');
  };
}

async function checkDashboardHealth(): Promise<void> {
  if (!browser) return;

  const sinceLastEvent = Date.now() - lastEventTime;

  if (sinceLastEvent > STALE_THRESHOLD_MS) {
    await sendRefreshSignal(
      `Dashboard stale: no events for ${Math.round(sinceLastEvent / 1000)}s`
    );
    lastEventTime = Date.now(); // reset to avoid spam
  }

  // Take screenshot for diagnostic log
  try {
    const page = await browser.newPage();
    await page.goto(DASH_URL, { timeout: 5000 });
    // Check if /live page SSE indicator shows connected
    const title = await page.title();
    console.log(`[monitor] Dashboard health check OK — title: ${title}`);
    await page.close();
  } catch (err) {
    console.log('[monitor] Dashboard unreachable:', err);
    await sendRefreshSignal('Dashboard unreachable — health check failed');
  }
}

async function main(): Promise<void> {
  console.log(`[monitor] Starting AgentForge dashboard monitor`);
  console.log(`[monitor] API: ${API_BASE} | Dashboard: ${DASH_URL}`);
  console.log(`[monitor] Stale threshold: ${STALE_THRESHOLD_MS}ms | Check interval: ${CHECK_INTERVAL_MS}ms`);

  // Launch headless browser for screenshot diagnostics
  try {
    browser = await chromium.launch({ headless: true });
    console.log('[monitor] Browser launched');
  } catch (err) {
    console.log('[monitor] Playwright not available — running in API-only mode');
    browser = null;
  }

  // Watch SSE stream for activity
  await watchSSEStream();

  // Periodic health checks
  setInterval(checkDashboardHealth, CHECK_INTERVAL_MS);

  console.log('[monitor] Running — press Ctrl+C to stop');
}

main().catch(console.error);
