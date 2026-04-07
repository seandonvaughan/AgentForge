/**
 * Single source of truth for the AgentForge version displayed in the dashboard.
 *
 * Pre-v6.7.3, every page hardcoded its own version string ("v5", "v6", "v6.1",
 * "v6.1.0") and they drifted out of sync. The server's /api/v5/health endpoint
 * now reads root package.json on boot and returns the real version, so the
 * dashboard fetches it once and exposes both the full semver and the
 * minor-only label everywhere via this store.
 */
import { writable, derived, type Readable } from 'svelte/store';

interface VersionState {
  full: string;       // e.g. "6.7.3"
  short: string;      // e.g. "v6.7"
  major: string;      // e.g. "v6"
  loaded: boolean;
}

const initial: VersionState = { full: '…', short: 'v…', major: 'v…', loaded: false };

export const versionStore = writable<VersionState>(initial);

/** Convenience derived store for components that just need the short label. */
export const versionShort: Readable<string> = derived(versionStore, ($v) => $v.short);
export const versionFull: Readable<string> = derived(versionStore, ($v) => $v.full);
export const versionMajor: Readable<string> = derived(versionStore, ($v) => $v.major);

let loaded = false;

/**
 * Fetch the version from /api/v5/health. Idempotent — safe to call from any
 * page's onMount; the second call is a no-op.
 */
export async function loadVersion(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const res = await fetch('/api/v5/health');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const full = String(json.version ?? 'unknown');
    const parts = full.split('.');
    const short = `v${parts.slice(0, 2).join('.')}`;
    const major = `v${parts[0] ?? '?'}`;
    versionStore.set({ full, short, major, loaded: true });
  } catch {
    // Leave the placeholder rather than crash a page on a missing health endpoint
    loaded = false;
  }
}
