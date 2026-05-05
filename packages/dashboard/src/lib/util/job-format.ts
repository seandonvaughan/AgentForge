export type RuntimeJobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

const CANCELLABLE_STATUSES = new Set<string>(['queued', 'running']);
const TERMINAL_STATUSES = new Set<string>(['completed', 'failed', 'cancelled']);

export function normalizeJobStatus(status: string | null | undefined): RuntimeJobStatus | 'unknown' {
  const normalized = String(status ?? '').toLowerCase();
  if (
    normalized === 'queued' ||
    normalized === 'running' ||
    normalized === 'completed' ||
    normalized === 'failed' ||
    normalized === 'cancelled'
  ) {
    return normalized;
  }
  return 'unknown';
}

export function isCancellableJobStatus(status: string | null | undefined): boolean {
  return CANCELLABLE_STATUSES.has(String(status ?? '').toLowerCase());
}

export function isTerminalJobStatus(status: string | null | undefined): boolean {
  return TERMINAL_STATUSES.has(String(status ?? '').toLowerCase());
}

export function jobStatusBadgeClass(status: string | null | undefined): string {
  switch (normalizeJobStatus(status)) {
    case 'completed':
      return 'success';
    case 'failed':
      return 'danger';
    case 'queued':
      return 'warning';
    case 'running':
      return 'sonnet';
    case 'cancelled':
      return 'muted';
    default:
      return 'muted';
  }
}

export function compactId(id: string | null | undefined, prefix = 8, suffix = 4): string {
  if (!id) return '-';
  if (id.length <= prefix + suffix + 1) return id;
  return `${id.slice(0, prefix)}...${id.slice(-suffix)}`;
}

export function formatJobDuration(
  startedAt: string | null | undefined,
  completedAt: string | null | undefined,
  now = Date.now(),
): string {
  if (!startedAt) return '-';
  const started = new Date(startedAt).getTime();
  const completed = completedAt ? new Date(completedAt).getTime() : now;
  if (!Number.isFinite(started) || !Number.isFinite(completed) || completed < started) return '-';

  const seconds = Math.floor((completed - started) / 1000);
  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return remainingSeconds ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

export function eventSummary(type: string | null | undefined, message: string | null | undefined): string {
  const cleanType = String(type ?? '').trim();
  const cleanMessage = String(message ?? '').trim();
  if (cleanMessage) return cleanMessage;
  if (cleanType) return cleanType.replace(/_/g, ' ');
  return 'event';
}
