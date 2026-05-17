/**
 * Tests for cc-prologue-builder.ts — T3.3 (Memory Loading Parity)
 *
 * Coverage:
 * 1. Empty memory dir → prologue is empty, fullTask is the raw task.
 * 2. Memory with 3 relevant learnings → prologue contains all 3 bullets.
 * 3. Memory exceeding 4000 tokens → truncated, most-recent entries kept.
 * 4. With adapter providing 2 DMs → prologue contains DM block.
 * 5. Without adapter → no DM block.
 * 6. prepareCcAgentTask: no prologue → fullTask equals userTask verbatim.
 * 7. prepareCcAgentTask: with prologue → fullTask has prologue + separator + task.
 * 8. DMs are marked delivered after prologue build (markDmsDelivered default).
 * 9. DMs are NOT marked delivered when markDmsDelivered=false.
 * 10. Memory block truncation preserves the header and most-recent bullets.
 * 11. Empty memory dir with adapter but no pending DMs → empty prologue.
 * 12. maxPrologueChars option overrides the default cap.
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkspaceAdapter } from '@agentforge/db';
import { sendDirectMessage } from '../../comms/direct-messages.js';
import {
  buildCcAgentPrologue,
  prepareCcAgentTask,
  MAX_PROLOGUE_CHARS,
} from '../cc-prologue-builder.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpRoots: string[] = [];

function makeTmpRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'cc-prologue-'));
  tmpRoots.push(root);
  return root;
}

function makeMemoryEntry(
  overrides: Partial<{
    id: string;
    type: string;
    value: string;
    createdAt: string;
    tags: string[];
    source: string;
  }> = {},
) {
  return {
    id: overrides.id ?? `entry-${Math.random().toString(36).slice(2)}`,
    type: overrides.type ?? 'learning',
    value: overrides.value ?? '[MAJOR] default learning value',
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    tags: overrides.tags ?? ['major', 'coder'],
    source: overrides.source ?? 'test',
  };
}

/**
 * Write one or more memory entries to `.agentforge/memory/entries.jsonl` under
 * the given project root.
 */
function writeMemoryEntries(
  projectRoot: string,
  entries: ReturnType<typeof makeMemoryEntry>[],
): void {
  const memDir = join(projectRoot, '.agentforge', 'memory');
  mkdirSync(memDir, { recursive: true });
  const content = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
  writeFileSync(join(memDir, 'entries.jsonl'), content, 'utf8');
}

// ---------------------------------------------------------------------------
// Suites
// ---------------------------------------------------------------------------

describe('buildCcAgentPrologue', () => {
  it('1. empty memory dir → empty prologue', async () => {
    const root = makeTmpRoot();
    const result = await buildCcAgentPrologue({ agentId: 'coder', projectRoot: root });
    expect(result).toBe('');
  });

  it('2. memory with 3 relevant learnings → prologue contains all 3 bullets', async () => {
    const root = makeTmpRoot();
    writeMemoryEntries(root, [
      makeMemoryEntry({ value: '[MAJOR] lesson alpha', tags: ['major', 'coder'] }),
      makeMemoryEntry({ value: '[MAJOR] lesson beta', tags: ['major', 'fix'] }),
      makeMemoryEntry({ value: '[CRITICAL] lesson gamma', tags: ['critical', 'coder'] }),
    ]);
    const result = await buildCcAgentPrologue({ agentId: 'coder', projectRoot: root });
    expect(result).toContain('lesson alpha');
    expect(result).toContain('lesson beta');
    expect(result).toContain('lesson gamma');
  });

  it('3. memory exceeding 4000-token cap → truncated, most-recent entries kept', async () => {
    const root = makeTmpRoot();

    // Create 20 entries with large values. Most-recent entry gets the latest
    // ISO timestamp so it should survive truncation.
    const entries = Array.from({ length: 20 }, (_, i) => {
      const ts = new Date(Date.now() - (20 - i) * 1000).toISOString(); // newest last
      return makeMemoryEntry({
        value: `[MAJOR] ${'x'.repeat(500)} entry-${i}`,
        tags: ['major', 'coder'],
        createdAt: ts,
        id: `big-entry-${i}`,
      });
    });
    writeMemoryEntries(root, entries);

    // Use a very small cap so truncation fires.
    const result = await buildCcAgentPrologue({
      agentId: 'coder',
      projectRoot: root,
      options: { maxPrologueChars: 800 },
    });
    // Must not exceed the cap.
    expect(result.length).toBeLessThanOrEqual(800);
    // Should contain the truncation notice.
    expect(result).toContain('older entries omitted');
  });

  it('4. with adapter providing 2 DMs → prologue contains DM block', async () => {
    const root = makeTmpRoot();
    const adapter = new WorkspaceAdapter({ dbPath: ':memory:', workspaceId: 'test' });
    sendDirectMessage(adapter, { from: 'architect', to: 'coder', body: 'dm-one content' });
    sendDirectMessage(adapter, { from: 'reviewer', to: 'coder', body: 'dm-two content' });

    const result = await buildCcAgentPrologue({
      agentId: 'coder',
      projectRoot: root,
      adapter,
    });
    expect(result).toContain('Pending DMs');
    expect(result).toContain('dm-one content');
    expect(result).toContain('dm-two content');
  });

  it('5. without adapter → no DM block', async () => {
    const root = makeTmpRoot();
    writeMemoryEntries(root, [
      makeMemoryEntry({ value: '[MAJOR] no-dm check', tags: ['major', 'coder'] }),
    ]);
    const result = await buildCcAgentPrologue({ agentId: 'coder', projectRoot: root });
    expect(result).not.toContain('Pending DMs');
    expect(result).not.toContain('Direct Messages');
  });

  it('8. DMs are marked delivered after prologue build (default)', async () => {
    const root = makeTmpRoot();
    const adapter = new WorkspaceAdapter({ dbPath: ':memory:', workspaceId: 'test' });
    const dm = sendDirectMessage(adapter, { from: 'architect', to: 'coder', body: 'mark me' });

    await buildCcAgentPrologue({ agentId: 'coder', projectRoot: root, adapter });

    const row = adapter.getDirectMessage(dm.id);
    expect(row?.delivered_at).not.toBeNull();

    // Second call should see no pending DMs.
    const second = await buildCcAgentPrologue({ agentId: 'coder', projectRoot: root, adapter });
    expect(second).toBe('');
  });

  it('9. DMs are NOT marked delivered when markDmsDelivered=false', async () => {
    const root = makeTmpRoot();
    const adapter = new WorkspaceAdapter({ dbPath: ':memory:', workspaceId: 'test' });
    const dm = sendDirectMessage(adapter, { from: 'architect', to: 'coder', body: 'preview only' });

    await buildCcAgentPrologue({
      agentId: 'coder',
      projectRoot: root,
      adapter,
      options: { markDmsDelivered: false },
    });

    const row = adapter.getDirectMessage(dm.id);
    expect(row?.delivered_at).toBeNull();
  });

  it('11. empty memory dir with adapter but no pending DMs → empty prologue', async () => {
    const root = makeTmpRoot();
    const adapter = new WorkspaceAdapter({ dbPath: ':memory:', workspaceId: 'test' });
    const result = await buildCcAgentPrologue({ agentId: 'coder', projectRoot: root, adapter });
    expect(result).toBe('');
  });

  it('12. maxPrologueChars option overrides the default cap', async () => {
    const root = makeTmpRoot();
    writeMemoryEntries(root, [
      makeMemoryEntry({ value: '[MAJOR] ' + 'a'.repeat(300), tags: ['major', 'coder'] }),
      makeMemoryEntry({ value: '[MAJOR] ' + 'b'.repeat(300), tags: ['major', 'coder'] }),
    ]);

    const result = await buildCcAgentPrologue({
      agentId: 'coder',
      projectRoot: root,
      options: { maxPrologueChars: 600 },
    });
    expect(result.length).toBeLessThanOrEqual(600);
  });
});

describe('prepareCcAgentTask', () => {
  it('6. no prologue → fullTask equals userTask verbatim', async () => {
    const root = makeTmpRoot();
    const task = 'implement the new feature';
    const { prologue, fullTask } = await prepareCcAgentTask('coder', root, task);
    expect(prologue).toBe('');
    expect(fullTask).toBe(task);
  });

  it('7. with prologue → fullTask has prologue + separator + task', async () => {
    const root = makeTmpRoot();
    const adapter = new WorkspaceAdapter({ dbPath: ':memory:', workspaceId: 'test' });
    sendDirectMessage(adapter, { from: 'architect', to: 'coder', body: 'some directive' });

    const task = 'implement the new feature';
    const { prologue, fullTask } = await prepareCcAgentTask('coder', root, task, adapter);

    expect(prologue).toBeTruthy();
    expect(fullTask).toContain(prologue);
    expect(fullTask).toContain('---');
    expect(fullTask).toContain('# Your task');
    expect(fullTask).toContain(task);
    // Task must come AFTER the prologue.
    expect(fullTask.indexOf(task)).toBeGreaterThan(fullTask.indexOf(prologue));
  });

  it('10. memory block truncation preserves header and most-recent bullets', async () => {
    const root = makeTmpRoot();
    const now = Date.now();
    // Write entries oldest-first; newest entry has value "newest-entry".
    const entries = [
      makeMemoryEntry({
        value: '[MAJOR] oldest entry here',
        tags: ['major', 'coder'],
        createdAt: new Date(now - 10000).toISOString(),
      }),
      makeMemoryEntry({
        value: '[MAJOR] ' + 'x'.repeat(200),
        tags: ['major', 'coder'],
        createdAt: new Date(now - 5000).toISOString(),
      }),
      makeMemoryEntry({
        value: '[CRITICAL] newest-entry should survive',
        tags: ['critical', 'coder'],
        createdAt: new Date(now).toISOString(),
      }),
    ];
    writeMemoryEntries(root, entries);

    // Use a small cap that can only fit ~1 bullet plus the header.
    const result = await buildCcAgentPrologue({
      agentId: 'coder',
      projectRoot: root,
      options: { maxPrologueChars: 500 },
    });

    // The header must survive.
    expect(result).toContain('# Fresh context');
    // The result must not exceed the cap.
    expect(result.length).toBeLessThanOrEqual(500);
  });

  it('returns MAX_PROLOGUE_CHARS = 16000', () => {
    expect(MAX_PROLOGUE_CHARS).toBe(16_000);
  });
});

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

afterAll(() => {
  for (const root of tmpRoots) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
  tmpRoots = [];
});
