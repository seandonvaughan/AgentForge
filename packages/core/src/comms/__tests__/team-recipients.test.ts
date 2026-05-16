/**
 * Tests for the `@team-*` alias resolver. Two resolution layers:
 *
 *   1. Per-agent YAML `team:` field — exact-match scan over
 *      `.agentforge/agents/*.yaml`.
 *   2. `team.yaml` tier groupings (`agents.strategic`, etc.) — fallback
 *      when no YAML carries the requested team.
 *
 * The resolver caches per-directory, so each test sets up a fresh tmp dir
 * + clears the cache to keep state hermetic.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceAdapter } from '@agentforge/db';
import { sendInboxMessage } from '../inbox.js';
import {
  clearTeamRecipientsCache,
  resolveTeamRecipients,
} from '../team-recipients.js';

let agentforgeDir: string;

function writeAgent(name: string, team?: string): void {
  const lines = [`name: ${name}`, 'model: sonnet', `system_prompt: Test ${name}.`];
  if (team !== undefined) lines.push(`team: ${team}`);
  writeFileSync(join(agentforgeDir, 'agents', `${name}.yaml`), lines.join('\n'), 'utf8');
}

function writeTeamYaml(content: string): void {
  writeFileSync(join(agentforgeDir, 'team.yaml'), content, 'utf8');
}

beforeEach(() => {
  agentforgeDir = mkdtempSync(join(tmpdir(), 'agentforge-team-recip-'));
  mkdirSync(join(agentforgeDir, 'agents'), { recursive: true });
});

afterEach(() => {
  clearTeamRecipientsCache();
  rmSync(agentforgeDir, { recursive: true, force: true });
});

describe('resolveTeamRecipients', () => {
  it('returns null for a non-team recipient (preserves v1 @user invariant)', () => {
    expect(resolveTeamRecipients(agentforgeDir, '@user')).toBeNull();
    expect(resolveTeamRecipients(agentforgeDir, 'architect')).toBeNull();
  });

  it('resolves @team-runtime via the per-agent YAML team field', () => {
    writeAgent('runtime-engineer', 'runtime');
    writeAgent('bus-engineer', 'runtime');
    writeAgent('frontend-dev', 'experience');

    const result = resolveTeamRecipients(agentforgeDir, '@team-runtime');
    expect(result).toEqual(['bus-engineer', 'runtime-engineer']);
  });

  it('is case-insensitive for the alias slug', () => {
    writeAgent('a', 'Runtime');
    writeAgent('b', 'runtime');
    // Both YAML values normalize to lowercase 'runtime' when compared.
    expect(resolveTeamRecipients(agentforgeDir, '@team-RUNTIME')).toEqual(['a', 'b']);
  });

  it('falls back to team.yaml tier grouping when no YAML carries the team field', () => {
    // No `team:` field in any agent.
    writeAgent('reviewer-a');
    writeAgent('reviewer-b');
    writeAgent('coder');
    writeTeamYaml(
      [
        'name: test',
        'agents:',
        '  quality:',
        '    - reviewer-a',
        '    - reviewer-b',
        '  implementation:',
        '    - coder',
        '',
        'delegation_graph:',
        '  reviewer-a:',
        '    - coder',
      ].join('\n'),
    );

    const quality = resolveTeamRecipients(agentforgeDir, '@team-quality');
    expect(quality).toEqual(['reviewer-a', 'reviewer-b']);

    const impl = resolveTeamRecipients(agentforgeDir, '@team-implementation');
    expect(impl).toEqual(['coder']);
  });

  it('returns an empty array for an unknown alias (treated as bad-request upstream)', () => {
    writeAgent('coder', 'runtime');
    expect(resolveTeamRecipients(agentforgeDir, '@team-nonsuch')).toEqual([]);
  });

  it('YAML field takes precedence over team.yaml tier when both match', () => {
    writeAgent('coder', 'runtime');
    writeAgent('other', 'runtime');
    writeTeamYaml(
      [
        'agents:',
        '  runtime:',  // tier name happens to match the team slug
        '    - coder',
        '    - other',
        '    - phantom',  // not in YAML field — must NOT leak in
      ].join('\n'),
    );

    expect(resolveTeamRecipients(agentforgeDir, '@team-runtime')).toEqual(['coder', 'other']);
  });
});

describe('sendInboxMessage + expandRecipients', () => {
  let adapter: WorkspaceAdapter;
  beforeEach(() => {
    adapter = new WorkspaceAdapter({ dbPath: ':memory:', workspaceId: 'test' });
  });

  it('expands @team-frontend into N inbox_recipients rows', () => {
    writeAgent('frontend-dev', 'experience');
    writeAgent('ui-engineer', 'experience');
    writeAgent('architect', 'strategic');

    const { recipients } = sendInboxMessage(
      adapter,
      {
        body: 'frontend rollout question',
        kind: 'info',
        recipients: ['@team-experience'],
      },
      {
        expandRecipients: (r) => resolveTeamRecipients(agentforgeDir, r),
      },
    );
    const ids = recipients.map((r) => r.recipient).sort();
    expect(ids).toEqual(['frontend-dev', 'ui-engineer']);
  });

  it('mixes @user + @team-* in a single write (deduplicates)', () => {
    writeAgent('a', 'platform');
    writeAgent('b', 'platform');

    const { recipients } = sendInboxMessage(
      adapter,
      {
        body: 'cross-post',
        kind: 'info',
        recipients: ['@user', '@team-platform', 'a'],
      },
      {
        expandRecipients: (r) => resolveTeamRecipients(agentforgeDir, r),
      },
    );
    const ids = recipients.map((r) => r.recipient).sort();
    // @user remains, plus a + b. 'a' appears both as an explicit recipient
    // and in @team-platform — deduped to one row.
    expect(ids).toEqual(['@user', 'a', 'b']);
  });

  it('throws UnsupportedRecipientError for an unknown team alias', () => {
    expect(() =>
      sendInboxMessage(
        adapter,
        {
          body: 'oops',
          kind: 'info',
          recipients: ['@team-doesnotexist'],
        },
        {
          expandRecipients: (r) => resolveTeamRecipients(agentforgeDir, r),
        },
      ),
    ).toThrow(/not supported in v1|@team-doesnotexist/);
  });
});
