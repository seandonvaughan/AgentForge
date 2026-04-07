/**
 * Format an ISO timestamp as a short relative time ("2m ago", "yesterday").
 */
export function relativeTime(iso: string | number | Date | null | undefined): string {
  if (iso == null) return '—';
  const then = typeof iso === 'number' ? iso : new Date(iso).getTime();
  if (!Number.isFinite(then)) return '—';
  const now = Date.now();
  const diffMs = now - then;
  const abs = Math.abs(diffMs);
  const future = diffMs < 0;

  const sec = Math.round(abs / 1000);
  if (sec < 5) return 'just now';
  if (sec < 60) return future ? `in ${sec}s` : `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return future ? `in ${min}m` : `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return future ? `in ${hr}h` : `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day === 1) return future ? 'tomorrow' : 'yesterday';
  if (day < 30) return future ? `in ${day}d` : `${day}d ago`;
  const mon = Math.round(day / 30);
  if (mon < 12) return future ? `in ${mon}mo` : `${mon}mo ago`;
  const yr = Math.round(mon / 12);
  return future ? `in ${yr}y` : `${yr}y ago`;
}

/**
 * Format a millisecond duration as "4m 23s" / "1h 5m" / "12s".
 */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '—';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  if (min < 60) return remSec ? `${min}m ${remSec}s` : `${min}m`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return remMin ? `${hr}h ${remMin}m` : `${hr}h`;
}
