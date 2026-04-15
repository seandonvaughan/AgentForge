import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

function getRepositoryRoot(): string {
  const thisFile = fileURLToPath(import.meta.url);
  return join(dirname(thisFile), '..', '..', '..', '..', '..');
}

export function getRepositoryTemplatesDir(): string {
  return join(getRepositoryRoot(), 'templates');
}

export function getRepositoryDomainsDir(): string {
  return join(getRepositoryTemplatesDir(), 'domains');
}
