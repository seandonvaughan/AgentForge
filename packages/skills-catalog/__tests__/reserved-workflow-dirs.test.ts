import { afterEach, describe, expect, it, vi } from 'vitest';

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

function skillMarkdown(id: string): string {
  return `---
id: ${id}
version: 1.0.0
tags:
  - test
applies_to:
  - catalog-tests
max_tokens: 100
---

# ${id}

Body for ${id}.
`;
}

describe('reserved workflow directories', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.doUnmock('node:fs');
  });

  it('excludes proposal workflow directories before parsing markdown files', async () => {
    const readFileSync = vi.fn((filePath: string) => {
      const normalized = normalizePath(filePath);
      if (normalized.endsWith('/active.md')) return skillMarkdown('active-skill');
      if (normalized.endsWith('/candidate.md')) return skillMarkdown('candidate-skill');
      if (normalized.endsWith('/approved.md')) return skillMarkdown('approved-skill');
      if (normalized.endsWith('/invalid.md')) {
        return `---
id: invalid-proposal
status: proposed
---

# Invalid proposal
`;
      }
      throw new Error(`Unexpected catalog read: ${filePath}`);
    });

    vi.doMock('node:fs', () => ({
      existsSync: vi.fn(() => true),
      readdirSync: vi.fn((dir: string) => {
        const normalized = normalizePath(dir);
        if (normalized.endsWith('/skills')) return ['agentforge'];
        if (normalized.endsWith('/skills/agentforge')) return ['active.md', '_proposed', '_approved'];
        if (normalized.endsWith('/skills/agentforge/_proposed')) return ['candidate.md', 'invalid.md'];
        if (normalized.endsWith('/skills/agentforge/_approved')) return ['approved.md'];
        return [];
      }),
      statSync: vi.fn((filePath: string) => ({
        isDirectory: () => !normalizePath(filePath).endsWith('.md'),
      })),
      readFileSync,
    }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const { listSkills, _resetCache } = await import('../src/catalog.js');
    _resetCache();

    const skills = listSkills();

    expect(skills.map((skill) => skill.frontmatter.id)).toEqual(['active-skill']);
    expect(skills.every((skill) => !normalizePath(skill.filePath).includes('/_proposed/'))).toBe(true);
    expect(skills.every((skill) => !normalizePath(skill.filePath).includes('/_approved/'))).toBe(true);
    expect(readFileSync).not.toHaveBeenCalledWith(expect.stringContaining('_proposed'), 'utf-8');
    expect(readFileSync).not.toHaveBeenCalledWith(expect.stringContaining('_approved'), 'utf-8');
    expect(warn).not.toHaveBeenCalled();
  });
});
