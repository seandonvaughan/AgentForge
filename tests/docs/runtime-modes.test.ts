import { beforeAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const DOC_PATH = join(REPO_ROOT, 'docs', 'runtime-modes.md');
const RUNTIME_TYPES_PATH = join(REPO_ROOT, 'packages', 'core', 'src', 'runtime', 'types.ts');

let runtimeModesDoc = '';
let expectedUnion = '';

beforeAll(async () => {
  const [docContent, runtimeTypes] = await Promise.all([
    readFile(DOC_PATH, 'utf-8'),
    readFile(RUNTIME_TYPES_PATH, 'utf-8'),
  ]);

  runtimeModesDoc = docContent;
  const runtimeModeType = runtimeTypes.match(/export type RuntimeMode =([\s\S]*?);/);
  const runtimeModes = runtimeModeType
    ? Array.from(runtimeModeType[1].matchAll(/^\s*\|\s+'([^']+)'/gm), (match) => match[1])
    : [];
  expectedUnion = runtimeModes.map((mode) => `'${mode}'`).join(' | ');
});

describe('docs/runtime-modes.md', () => {
  it('documents the full resolveMode return union in Programmatic access', () => {
    const programmaticSection = runtimeModesDoc.split('## Programmatic access')[1] ?? '';
    expect(programmaticSection).toContain(`const mode = resolveMode();         // ${expectedUnion}`);
  });
});