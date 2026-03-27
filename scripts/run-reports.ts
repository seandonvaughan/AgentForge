#!/usr/bin/env node
/**
 * Generate analytics reports from live SQLite data.
 * Saves to .agentforge/reports/report-<timestamp>.json
 * Usage: npx tsx scripts/run-reports.ts [--db-path <path>]
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AgentDatabase } from '../src/db/database.js';
import { SqliteAdapter } from '../src/db/sqlite-adapter.js';
import { ReportGenerator } from '../src/analytics/report-generator.js';

const dbPath = process.argv.includes('--db-path')
  ? process.argv[process.argv.indexOf('--db-path') + 1]
  : join(process.cwd(), '.agentforge', 'audit.db');

const reportsDir = join(process.cwd(), '.agentforge', 'reports');

async function main() {
  const db = new AgentDatabase({ path: dbPath });
  const adapter = new SqliteAdapter({ db });
  const generator = new ReportGenerator(adapter);

  console.log('Generating analytics reports...');
  const report = await generator.generateAll();

  await mkdir(reportsDir, { recursive: true });
  const filename = `report-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  const outputPath = join(reportsDir, filename);

  await writeFile(outputPath, JSON.stringify(report, null, 2), 'utf-8');
  console.log(`✓ Report saved to ${outputPath}`);
  console.log(`  Sections: ${report.sections.map(s => s.title).join(', ')}`);

  db.close();
}

main().catch(err => { console.error(err); process.exit(1); });
