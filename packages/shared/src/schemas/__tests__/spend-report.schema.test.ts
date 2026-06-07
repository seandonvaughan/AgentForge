import { describe, expect, it } from 'vitest';
import { SpendReportSchema, type SpendReport } from '../spend-report.schema.js';

const validSpendReport: SpendReport = {
  schemaVersion: 1,
  cycleId: '22222222-2222-2222-2222-222222222222',
  epicId: 'epic-123',
  objective: 'Ship the spend report route',
  budgetUsd: 20,
  totalUsd: 8,
  executionUsd: 6,
  overheadUsd: 2,
  utilization: 0.4,
  perItem: [
    {
      itemId: 'child-1',
      title: 'Add zod schema',
      plannedUsd: 2,
      actualUsd: 1.75,
      status: 'completed',
    },
    {
      itemId: 'child-2',
      title: 'Wire spend route',
      plannedUsd: null,
      actualUsd: 0,
      status: 'pending',
    },
  ],
  generatedAt: '2026-06-06T12:00:00.000Z',
};

const malformedSamples: Array<[string, (report: SpendReport) => unknown]> = [
  ['missing required cycleId', ({ cycleId: _cycleId, ...report }) => report],
  ['wrong schemaVersion', (report) => ({ ...report, schemaVersion: 2 })],
  ['negative item actual', (report) => ({
    ...report,
    perItem: [{ ...report.perItem[0]!, actualUsd: -0.01 }],
  })],
  ['malformed generatedAt timestamp', (report) => ({
    ...report,
    generatedAt: '2026-06-06 12:00:00',
  })],
  ['unexpected top-level field', (report) => ({ ...report, extra: true })],
];

describe('SpendReportSchema', () => {
  it('validates a well-formed spend-report.json artifact', () => {
    expect(SpendReportSchema.parse(validSpendReport)).toEqual(validSpendReport);
  });

  it('allows optional epic and objective metadata to be absent', () => {
    const { epicId: _epicId, objective: _objective, ...withoutMetadata } = validSpendReport;

    expect(SpendReportSchema.parse(withoutMetadata)).toEqual(withoutMetadata);
  });

  it.each(malformedSamples)('rejects malformed sample: %s', (_name, mutate) => {
    expect(SpendReportSchema.safeParse(mutate(validSpendReport)).success).toBe(false);
  });
});
