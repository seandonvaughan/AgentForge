import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const componentPath = resolve(import.meta.dirname, '../EpicChildRow.svelte');
const source = readFileSync(componentPath, 'utf8');

describe('EpicChildRow', () => {
  it('declares the presentational props for one decomposition child', () => {
    expect(source).toContain('id: string;');
    expect(source).toContain('title: string;');
    expect(source).toContain('files?: string[];');
    expect(source).toContain('estimatedCostUsd?: number;');
    expect(source).toContain('status?: EpicChildStatus;');
  });

  it('renders id, title, file list, cost and a status badge', () => {
    expect(source).toContain('data-child-id={id}');
    expect(source).toContain('{title}');
    expect(source).toContain('files.join(');
    expect(source).toContain('{costLabel}');
    expect(source).toContain('<Badge {variant}>{status}</Badge>');
  });

  it('maps every status to a Badge variant', () => {
    for (const status of ['pending', 'queued', 'running', 'done', 'failed', 'blocked']) {
      expect(source).toContain(`${status}:`);
    }
  });

  it('accepts an external class override and is pure presentational', () => {
    expect(source).toContain("class: className = ''");
    // Iron law: atoms have zero data fetching and zero workspace deps.
    expect(source).not.toContain('fetch(');
    expect(source).not.toContain('@agentforge/');
  });
});
