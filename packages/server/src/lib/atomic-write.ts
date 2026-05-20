import { randomBytes } from 'node:crypto';
import { renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

function safeTempNameSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_');
}

export function makeAtomicTempPath(filePath: string, prefix = 'agentforge'): string {
  const dir = dirname(filePath);
  const base = safeTempNameSegment(basename(filePath));
  const suffix = randomBytes(8).toString('hex');
  return join(dir, `.${base}.${prefix}-${process.pid}-${suffix}.tmp`);
}

export function writeFileAtomicSync(filePath: string, content: string): void {
  const tmpPath = makeAtomicTempPath(filePath);
  try {
    writeFileSync(tmpPath, content, 'utf-8');
    renameSync(tmpPath, filePath);
  } catch (error) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // Best-effort cleanup only; preserve the original write/rename error.
    }
    throw error;
  }
}
