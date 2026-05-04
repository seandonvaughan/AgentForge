import { describe, expect, it } from 'vitest';
import {
  compactId,
  eventSummary,
  formatJobDuration,
  isCancellableJobStatus,
  isTerminalJobStatus,
  jobStatusBadgeClass,
  normalizeJobStatus,
} from '../lib/util/job-format.js';

describe('job-format utilities', () => {
  it('normalizes known statuses and rejects unknown values', () => {
    expect(normalizeJobStatus('queued')).toBe('queued');
    expect(normalizeJobStatus('running')).toBe('running');
    expect(normalizeJobStatus('RUNNING')).toBe('running');
    expect(normalizeJobStatus('paused')).toBe('unknown');
    expect(normalizeJobStatus(undefined)).toBe('unknown');
  });

  it('allows cancellation only for queued and running jobs', () => {
    expect(isCancellableJobStatus('queued')).toBe(true);
    expect(isCancellableJobStatus('running')).toBe(true);
    expect(isCancellableJobStatus('completed')).toBe(false);
    expect(isCancellableJobStatus('failed')).toBe(false);
    expect(isCancellableJobStatus('cancelled')).toBe(false);
  });

  it('identifies terminal job statuses', () => {
    expect(isTerminalJobStatus('completed')).toBe(true);
    expect(isTerminalJobStatus('failed')).toBe(true);
    expect(isTerminalJobStatus('cancelled')).toBe(true);
    expect(isTerminalJobStatus('running')).toBe(false);
  });

  it('maps statuses to dashboard badge classes', () => {
    expect(jobStatusBadgeClass('completed')).toBe('success');
    expect(jobStatusBadgeClass('failed')).toBe('danger');
    expect(jobStatusBadgeClass('queued')).toBe('warning');
    expect(jobStatusBadgeClass('running')).toBe('sonnet');
    expect(jobStatusBadgeClass('cancelled')).toBe('muted');
  });

  it('compacts long ids but leaves short ids unchanged', () => {
    expect(compactId('job-1234567890abcdef')).toBe('job-1234...cdef');
    expect(compactId('job-123')).toBe('job-123');
    expect(compactId(undefined)).toBe('-');
  });

  it('formats elapsed job duration from timestamps', () => {
    expect(formatJobDuration('2026-05-01T10:00:00.000Z', '2026-05-01T10:00:42.000Z')).toBe('42s');
    expect(formatJobDuration('2026-05-01T10:00:00.000Z', '2026-05-01T10:02:05.000Z')).toBe('2m 5s');
    expect(formatJobDuration('2026-05-01T10:00:00.000Z', undefined, Date.parse('2026-05-01T11:04:00.000Z'))).toBe('1h 4m');
    expect(formatJobDuration('not-a-date', undefined)).toBe('-');
  });

  it('summarizes events from message first, then type', () => {
    expect(eventSummary('chunk', '[coder] chunk')).toBe('[coder] chunk');
    expect(eventSummary('job_started', '')).toBe('job started');
    expect(eventSummary(undefined, undefined)).toBe('event');
  });
});
