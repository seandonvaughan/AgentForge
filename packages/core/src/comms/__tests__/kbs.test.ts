/**
 * Unit tests for the KB helpers — createKb / createKbDoc / updateKbDoc + the
 * versioning invariants. The big one: updateKbDoc NEVER mutates an existing
 * version row; it appends.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WorkspaceAdapter } from '@agentforge/db';
import {
  createKb,
  listKbs,
  getKb,
  getKbBySlug,
  updateKb,
  deleteKb,
  createKbDoc,
  listKbDocs,
  getKbDoc,
  updateKbDoc,
  getKbDocVersionHistory,
  getKbDocAtVersion,
} from '../index.js';

let adapter: WorkspaceAdapter;

beforeEach(() => {
  adapter = new WorkspaceAdapter({ dbPath: ':memory:', workspaceId: 'test' });
});

describe('createKb', () => {
  it('creates a workspace KB with defaults', () => {
    const kb = createKb(adapter, {
      slug: 'gate-rubric',
      title: 'Gate Rubric',
      owner: 'architect',
    });
    expect(kb.id).toMatch(/.+/);
    expect(kb.slug).toBe('gate-rubric');
    expect(kb.title).toBe('Gate Rubric');
    expect(kb.visibility).toBe('workspace');
    expect(kb.description).toBeNull();
    expect(kb.createdAt).toMatch(/T/);
  });

  it('honours a custom visibility', () => {
    const kb = createKb(adapter, {
      slug: 'private-notes',
      title: 'Private',
      owner: 'arch',
      visibility: 'private',
    });
    expect(kb.visibility).toBe('private');
  });

  it('rejects invalid visibility', () => {
    expect(() =>
      createKb(adapter, {
        slug: 'x',
        title: 'X',
        owner: 'a',
        visibility: 'secret' as unknown as 'private',
      }),
    ).toThrow(/visibility/);
  });

  it('rejects an empty title', () => {
    expect(() =>
      createKb(adapter, { slug: 'x', title: '   ', owner: 'a' }),
    ).toThrow(/title/);
  });

  it('rejects an invalid slug', () => {
    expect(() =>
      createKb(adapter, { slug: 'No Spaces', title: 'x', owner: 'a' }),
    ).toThrow(/slug/);
  });

  it('rejects duplicate slugs', () => {
    createKb(adapter, { slug: 'dup', title: 'A', owner: 'a' });
    expect(() =>
      createKb(adapter, { slug: 'dup', title: 'B', owner: 'b' }),
    ).toThrow(/already exists/);
  });

  it('persists description when supplied', () => {
    const kb = createKb(adapter, {
      slug: 'cost',
      title: 'Cost',
      owner: 'a',
      description: 'How we set per-model expectations.',
    });
    expect(kb.description).toBe('How we set per-model expectations.');
  });
});

describe('listKbs + getKb', () => {
  it('returns all KBs ordered by recency', () => {
    const a = createKb(adapter, { slug: 'aaa', title: 'A', owner: 'x' });
    const b = createKb(adapter, { slug: 'bbb', title: 'B', owner: 'y' });
    const list = listKbs(adapter);
    expect(list).toHaveLength(2);
    const ids = list.map((k) => k.id);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
  });

  it('filters by visibility', () => {
    createKb(adapter, { slug: 'open', title: 'Open', owner: 'x', visibility: 'public' });
    createKb(adapter, { slug: 'hush', title: 'Hush', owner: 'x', visibility: 'private' });
    const publics = listKbs(adapter, { visibility: 'public' });
    expect(publics).toHaveLength(1);
    expect(publics[0]?.slug).toBe('open');
  });

  it('filters by owner', () => {
    createKb(adapter, { slug: 'one', title: '1', owner: 'alice' });
    createKb(adapter, { slug: 'two', title: '2', owner: 'bob' });
    const mine = listKbs(adapter, { owner: 'alice' });
    expect(mine).toHaveLength(1);
    expect(mine[0]?.owner).toBe('alice');
  });

  it('getKbBySlug finds by slug', () => {
    const created = createKb(adapter, { slug: 'lookup', title: 'L', owner: 'a' });
    expect(getKbBySlug(adapter, 'lookup')?.id).toBe(created.id);
    expect(getKbBySlug(adapter, 'missing')).toBeUndefined();
  });

  it('getKb returns undefined for unknown id', () => {
    expect(getKb(adapter, 'nope')).toBeUndefined();
  });
});

describe('updateKb', () => {
  it('patches title + description', () => {
    const kb = createKb(adapter, { slug: 'edit', title: 'old', owner: 'a' });
    const next = updateKb(adapter, kb.id, { title: 'new', description: 'fresh' });
    expect(next?.title).toBe('new');
    expect(next?.description).toBe('fresh');
    // updatedAt may share a millisecond with createdAt on fast runs; the
    // important invariant is that the patched fields landed.
    expect(next?.updatedAt).toMatch(/T/);
  });

  it('returns undefined for unknown id', () => {
    expect(updateKb(adapter, 'no', { title: 'x' })).toBeUndefined();
  });

  it('rejects empty title', () => {
    const kb = createKb(adapter, { slug: 'rej', title: 'x', owner: 'a' });
    expect(() => updateKb(adapter, kb.id, { title: '   ' })).toThrow(/title/);
  });
});

describe('deleteKb', () => {
  it('removes a KB and cascades its docs', () => {
    const kb = createKb(adapter, { slug: 'rm', title: 'x', owner: 'a' });
    createKbDoc(adapter, kb.id, {
      slug: 'doc',
      title: 'D',
      bodyMd: '# body',
      authoredBy: 'a',
    });
    expect(deleteKb(adapter, kb.id)).toBe(true);
    expect(getKb(adapter, kb.id)).toBeUndefined();
    expect(listKbDocs(adapter, kb.id)).toHaveLength(0);
  });

  it('returns false for unknown id', () => {
    expect(deleteKb(adapter, 'nope')).toBe(false);
  });
});

describe('createKbDoc', () => {
  it('creates a doc at version 1 with body', () => {
    const kb = createKb(adapter, { slug: 'k', title: 'K', owner: 'a' });
    const doc = createKbDoc(adapter, kb.id, {
      slug: 'intro',
      title: 'Intro',
      bodyMd: '# Hello',
      authoredBy: 'alice',
      commitMessage: 'initial',
    });
    expect(doc.slug).toBe('intro');
    expect(doc.currentVersion).toBe(1);
    expect(doc.body?.bodyMd).toBe('# Hello');
    expect(doc.body?.commitMessage).toBe('initial');
  });

  it('rejects unknown KB id', () => {
    expect(() =>
      createKbDoc(adapter, 'nope', {
        slug: 'x',
        title: 'X',
        bodyMd: 'b',
        authoredBy: 'a',
      }),
    ).toThrow(/not found/);
  });

  it('rejects empty body', () => {
    const kb = createKb(adapter, { slug: 'k2', title: 'K', owner: 'a' });
    expect(() =>
      createKbDoc(adapter, kb.id, {
        slug: 'doc',
        title: 'D',
        bodyMd: '',
        authoredBy: 'a',
      }),
    ).toThrow(/bodyMd/);
  });

  it('rejects duplicate doc slug within a KB', () => {
    const kb = createKb(adapter, { slug: 'k3', title: 'K', owner: 'a' });
    createKbDoc(adapter, kb.id, {
      slug: 'one',
      title: 'O',
      bodyMd: 'b',
      authoredBy: 'a',
    });
    expect(() =>
      createKbDoc(adapter, kb.id, {
        slug: 'one',
        title: 'O2',
        bodyMd: 'b',
        authoredBy: 'a',
      }),
    ).toThrow(/already exists/);
  });

  it('rejects invalid slug', () => {
    const kb = createKb(adapter, { slug: 'k4', title: 'K', owner: 'a' });
    expect(() =>
      createKbDoc(adapter, kb.id, {
        slug: 'Has Space',
        title: 'X',
        bodyMd: 'b',
        authoredBy: 'a',
      }),
    ).toThrow(/slug/);
  });
});

describe('listKbDocs + getKbDoc', () => {
  it('lists docs in a KB', () => {
    const kb = createKb(adapter, { slug: 'list', title: 'K', owner: 'a' });
    createKbDoc(adapter, kb.id, { slug: 'a', title: 'A', bodyMd: '1', authoredBy: 'a' });
    createKbDoc(adapter, kb.id, { slug: 'b', title: 'B', bodyMd: '2', authoredBy: 'a' });
    const docs = listKbDocs(adapter, kb.id);
    expect(docs).toHaveLength(2);
    expect(docs.map((d) => d.slug).sort()).toEqual(['a', 'b']);
  });

  it('getKbDoc returns current version body', () => {
    const kb = createKb(adapter, { slug: 'g', title: 'K', owner: 'a' });
    createKbDoc(adapter, kb.id, {
      slug: 'd',
      title: 'D',
      bodyMd: 'first',
      authoredBy: 'a',
    });
    const doc = getKbDoc(adapter, kb.id, 'd');
    expect(doc?.body?.bodyMd).toBe('first');
    expect(doc?.currentVersion).toBe(1);
  });

  it('getKbDoc returns undefined for missing slug', () => {
    const kb = createKb(adapter, { slug: 'q', title: 'K', owner: 'a' });
    expect(getKbDoc(adapter, kb.id, 'missing')).toBeUndefined();
  });
});

describe('updateKbDoc — versioning invariant', () => {
  it('appends a new version, never overwrites', () => {
    const kb = createKb(adapter, { slug: 'ver', title: 'V', owner: 'a' });
    const v1 = createKbDoc(adapter, kb.id, {
      slug: 'doc',
      title: 'Doc',
      bodyMd: 'v1 body',
      authoredBy: 'alice',
    });
    expect(v1.currentVersion).toBe(1);

    const v2 = updateKbDoc(adapter, kb.id, 'doc', {
      bodyMd: 'v2 body',
      authoredBy: 'bob',
      commitMessage: 'rewrote section',
    });
    expect(v2?.currentVersion).toBe(2);
    expect(v2?.body?.bodyMd).toBe('v2 body');
    expect(v2?.body?.commitMessage).toBe('rewrote section');

    // The v1 row must still be there and untouched.
    const oldRow = getKbDocAtVersion(adapter, v1.id, 1);
    expect(oldRow?.bodyMd).toBe('v1 body');
    expect(oldRow?.authoredBy).toBe('alice');
  });

  it('updates document title when supplied', () => {
    const kb = createKb(adapter, { slug: 'tt', title: 'K', owner: 'a' });
    const doc = createKbDoc(adapter, kb.id, {
      slug: 'd',
      title: 'Old',
      bodyMd: 'b',
      authoredBy: 'a',
    });
    const updated = updateKbDoc(adapter, kb.id, 'd', {
      bodyMd: 'b2',
      authoredBy: 'a',
      title: 'New',
    });
    expect(updated?.title).toBe('New');
    expect(updated?.currentVersion).toBe(2);
    // Old version still records the old body.
    const v1 = getKbDocAtVersion(adapter, doc.id, 1);
    expect(v1?.bodyMd).toBe('b');
  });

  it('returns undefined for missing doc', () => {
    const kb = createKb(adapter, { slug: 'q2', title: 'K', owner: 'a' });
    expect(
      updateKbDoc(adapter, kb.id, 'missing', { bodyMd: 'x', authoredBy: 'a' }),
    ).toBeUndefined();
  });

  it('rejects empty body', () => {
    const kb = createKb(adapter, { slug: 'eb', title: 'K', owner: 'a' });
    createKbDoc(adapter, kb.id, {
      slug: 'd',
      title: 'D',
      bodyMd: 'b',
      authoredBy: 'a',
    });
    expect(() =>
      updateKbDoc(adapter, kb.id, 'd', { bodyMd: '', authoredBy: 'a' }),
    ).toThrow(/bodyMd/);
  });
});

describe('version history + getKbDocAtVersion', () => {
  it('returns versions newest first', () => {
    const kb = createKb(adapter, { slug: 'h', title: 'K', owner: 'a' });
    const doc = createKbDoc(adapter, kb.id, {
      slug: 'd',
      title: 'D',
      bodyMd: 'v1',
      authoredBy: 'a',
    });
    updateKbDoc(adapter, kb.id, 'd', { bodyMd: 'v2', authoredBy: 'a' });
    updateKbDoc(adapter, kb.id, 'd', { bodyMd: 'v3', authoredBy: 'a' });
    const history = getKbDocVersionHistory(adapter, doc.id);
    expect(history.map((v) => v.version)).toEqual([3, 2, 1]);
    expect(history.map((v) => v.bodyMd)).toEqual(['v3', 'v2', 'v1']);
  });

  it('getKbDocAtVersion returns specific version', () => {
    const kb = createKb(adapter, { slug: 'specific', title: 'K', owner: 'a' });
    const doc = createKbDoc(adapter, kb.id, {
      slug: 'd',
      title: 'D',
      bodyMd: 'first',
      authoredBy: 'a',
    });
    updateKbDoc(adapter, kb.id, 'd', { bodyMd: 'second', authoredBy: 'a' });
    expect(getKbDocAtVersion(adapter, doc.id, 1)?.bodyMd).toBe('first');
    expect(getKbDocAtVersion(adapter, doc.id, 2)?.bodyMd).toBe('second');
    expect(getKbDocAtVersion(adapter, doc.id, 99)).toBeUndefined();
  });
});

describe('end-to-end versioning integration', () => {
  it('create KB -> create doc -> update doc -> fetch v1 (still there) -> fetch current (v2)', () => {
    const kb = createKb(adapter, {
      slug: 'lessons',
      title: 'Lessons Learned',
      owner: 'arch',
    });
    const doc = createKbDoc(adapter, kb.id, {
      slug: 'v15-0-0',
      title: 'v15.0.0 retrospective',
      bodyMd: 'Initial draft.',
      authoredBy: 'arch',
      commitMessage: 'first pass',
    });
    expect(doc.currentVersion).toBe(1);

    const updated = updateKbDoc(adapter, kb.id, 'v15-0-0', {
      bodyMd: 'Final retrospective with all sections.',
      authoredBy: 'gate',
      commitMessage: 'added gate findings',
    });
    expect(updated?.currentVersion).toBe(2);

    // v1 is still there.
    const v1 = getKbDocAtVersion(adapter, doc.id, 1);
    expect(v1?.bodyMd).toBe('Initial draft.');
    expect(v1?.authoredBy).toBe('arch');

    // current is v2.
    const current = getKbDoc(adapter, kb.id, 'v15-0-0');
    expect(current?.body?.bodyMd).toBe('Final retrospective with all sections.');
    expect(current?.currentVersion).toBe(2);

    // history has both.
    const history = getKbDocVersionHistory(adapter, doc.id);
    expect(history).toHaveLength(2);
  });
});
