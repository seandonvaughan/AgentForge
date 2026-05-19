import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const assets = [
  ['src/autonomous/self-eval/prompt-fragment.md', 'dist/autonomous/self-eval/prompt-fragment.md'],
  ['src/runtime/pr-merge-manager-prompt.md', 'dist/runtime/pr-merge-manager-prompt.md'],
];

for (const [from, to] of assets) {
  const target = join(root, to);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(join(root, from), target);
}
