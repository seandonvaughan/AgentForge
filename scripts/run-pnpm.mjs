#!/usr/bin/env node

import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const args = process.argv.slice(2);
if (args[0] === '--') args.shift();

function executableCandidates(command) {
  if (process.platform !== 'win32') return [command];
  const pathext = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .filter(Boolean);
  return [command, ...pathext.map((ext) => `${command}${ext.toLowerCase()}`)];
}

function resolveOnPath(command) {
  const pathEntries = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  for (const dir of pathEntries) {
    for (const candidate of executableCandidates(command)) {
      const fullPath = join(dir, candidate);
      try {
        accessSync(fullPath, constants.X_OK);
        return fullPath;
      } catch {
        // Keep scanning PATH.
      }
    }
  }
  return null;
}

const pnpm = resolveOnPath('pnpm');
if (pnpm) {
  const command = process.platform === 'win32' ? 'pnpm' : pnpm;
  const result = spawnSync(command, args, { stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}

if (process.env.CI) {
  console.error('pnpm was not found on PATH in CI. Ensure pnpm/action-setup runs before this script.');
  process.exit(1);
}

const corepack = resolveOnPath('corepack');
if (!corepack) {
  console.error('Neither pnpm nor corepack was found on PATH.');
  process.exit(1);
}

const command = process.platform === 'win32' ? 'corepack' : corepack;
const result = spawnSync(command, ['pnpm', ...args], { stdio: 'inherit', shell: process.platform === 'win32' });
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
