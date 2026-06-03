import type { Command } from 'commander';
import {
  aggregateLessonOutcomes,
  computeOutcomeConfidence,
  readLessonAttributions,
  type LessonAttributionEntry,
} from '../../../core/dist/memory/lesson-attribution.js';

export interface LearningOutcomeRow {
  lessonId: string;
  appearances: number;
  passes: number;
  outcomeConfidence: number;
}

export function buildOutcomeRows(
  attributionEntries: LessonAttributionEntry[],
): LearningOutcomeRow[] {
  return [...aggregateLessonOutcomes(attributionEntries).entries()]
    .map(([lessonId, stats]) => ({
      lessonId,
      appearances: stats.appearances,
      passes: stats.passes,
      outcomeConfidence: computeOutcomeConfidence(stats.passes, stats.appearances),
    }))
    .sort((a, b) => (
      b.outcomeConfidence - a.outcomeConfidence
      || b.appearances - a.appearances
    ));
}

export function formatOutcomeRows(rows: LearningOutcomeRow[]): string {
  if (rows.length === 0) {
    return '[learnings] No lesson outcomes found.';
  }

  const printable = rows.map((row) => ({
    lessonId: shortenLessonId(row.lessonId),
    appearances: String(row.appearances),
    passes: String(row.passes),
    confidence: row.outcomeConfidence.toFixed(3),
  }));

  const widths = {
    lessonId: Math.max('lessonId'.length, ...printable.map((row) => row.lessonId.length)),
    appearances: Math.max('appearances'.length, ...printable.map((row) => row.appearances.length)),
    passes: Math.max('passes'.length, ...printable.map((row) => row.passes.length)),
    confidence: Math.max('confidence'.length, ...printable.map((row) => row.confidence.length)),
  };

  const lines = [
    [
      'lessonId'.padEnd(widths.lessonId),
      'appearances'.padStart(widths.appearances),
      'passes'.padStart(widths.passes),
      'confidence'.padStart(widths.confidence),
    ].join('  '),
  ];

  for (const row of printable) {
    lines.push([
      row.lessonId.padEnd(widths.lessonId),
      row.appearances.padStart(widths.appearances),
      row.passes.padStart(widths.passes),
      row.confidence.padStart(widths.confidence),
    ].join('  '));
  }

  return lines.join('\n');
}

export function registerLearningsCommand(program: Command): void {
  const learnings = program.commands.find((command) => command.name() === 'learnings')
    ?? program
      .command('learnings')
      .description('Inspect AgentForge learning flywheel signals');

  learnings
    .command('outcomes')
    .description('List per-lesson outcome-confidence from lesson attribution memory')
    .option('--project-root <path>', 'Project root', process.cwd())
    .option('--json', 'Print outcome rows as JSON')
    .action((options: { projectRoot: string; json?: boolean }) => {
      try {
        const entries = readLessonAttributions(options.projectRoot);
        const rows = buildOutcomeRows(entries);

        if (options.json) {
          console.log(JSON.stringify(rows, null, 2));
          return;
        }

        console.log(formatOutcomeRows(rows));
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      }
    });
}

function shortenLessonId(lessonId: string): string {
  return lessonId.length > 12 ? `${lessonId.slice(0, 12)}...` : lessonId;
}
