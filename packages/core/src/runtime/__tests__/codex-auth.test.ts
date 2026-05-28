import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Guard the anti-fake requirement: auth state must be derived from FILE CONTENTS,
// never by spawning `codex login status`. We mock node:child_process so any spawn
// attempt inside resolveCodexAuth would be observable (and we assert it is not).
const spawnMock = vi.hoisted(() => vi.fn());
const spawnSyncMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: spawnMock, spawnSync: spawnSyncMock };
});

import { resolveCodexAuth } from '../codex-auth.js';
import { CodexAuthError } from '../transport-errors.js';
import { CodexCliTransport } from '../transports/codex-cli-transport.js';
import type { ExecutionRequest } from '../types.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

let homeRoot: string;
let codexHome: string;

beforeEach(() => {
  homeRoot = mkdtempSync(join(tmpdir(), 'agentforge-codex-auth-'));
  codexHome = join(homeRoot, 'codex-home');
});

afterEach(() => {
  rmSync(homeRoot, { recursive: true, force: true });
  spawnMock.mockReset();
  spawnSyncMock.mockReset();
});

function writeAuthFile(dir: string, contents: string): void {
  writeFileSync(join(dir, 'auth.json'), contents, 'utf8');
}

/** Create the CODEX_HOME fixture dir and return its path. */
function makeCodexHome(): string {
  mkdirSync(codexHome, { recursive: true });
  return codexHome;
}

/** Build a fake JWT with the given exp (seconds since epoch). */
function jwtWithExp(expSeconds: number): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds })).toString('base64url');
  return `${header}.${payload}.sig`;
}

function makeRequest(overrides: Partial<ExecutionRequest> = {}): ExecutionRequest {
  return {
    agent: {
      agentId: 'coder',
      name: 'Coder',
      model: 'sonnet',
      systemPrompt: 'You are a coder.',
      workspaceId: 'default',
    },
    task: 'Write code',
    userContent: 'Write code',
    modelId: 'gpt-5.3-codex',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// resolveCodexAuth — derived from file contents, no subprocess
// ---------------------------------------------------------------------------

describe('resolveCodexAuth', () => {
  it('reports authenticated for an OPENAI_API_KEY auth file', () => {
    const dir = makeCodexHome();
    writeAuthFile(dir, JSON.stringify({ OPENAI_API_KEY: 'sk-live-xxx', tokens: null }));

    const result = resolveCodexAuth({ CODEX_HOME: dir });

    expect(result.status).toBe('authenticated');
    expect(result.source).toBe('api-key');
    expect(result.path).toBe(join(dir, 'auth.json'));
    expect(spawnMock).not.toHaveBeenCalled();
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('reports authenticated for a non-expired OAuth token (exp in the future)', () => {
    const dir = makeCodexHome();
    const future = 2_000; // seconds
    writeAuthFile(
      dir,
      JSON.stringify({ OPENAI_API_KEY: null, tokens: { id_token: jwtWithExp(future) } }),
    );

    const result = resolveCodexAuth({ CODEX_HOME: dir }, { now: () => 1_000_000 }); // 1000s

    expect(result.status).toBe('authenticated');
    expect(result.source).toBe('tokens');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('reports expired when the OAuth token exp is in the past (derived from contents + clock)', () => {
    const dir = makeCodexHome();
    const past = 500; // seconds
    writeAuthFile(
      dir,
      JSON.stringify({ OPENAI_API_KEY: null, tokens: { id_token: jwtWithExp(past) } }),
    );

    const result = resolveCodexAuth({ CODEX_HOME: dir }, { now: () => 1_000_000 }); // 1000s > 500s

    expect(result.status).toBe('expired');
    expect(result.expiresAt).toBe(past * 1000);
    expect(spawnMock).not.toHaveBeenCalled();
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('reports missing when the auth file is absent', () => {
    const dir = makeCodexHome(); // exists but has no auth.json

    const result = resolveCodexAuth({ CODEX_HOME: dir });

    expect(result.status).toBe('missing');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('reports missing when the auth file is malformed JSON', () => {
    const dir = makeCodexHome();
    writeAuthFile(dir, '{ this is not valid json ');

    const result = resolveCodexAuth({ CODEX_HOME: dir });

    expect(result.status).toBe('missing');
    expect(result.reason).toMatch(/malformed/i);
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('honors CODEX_HOME over the default home dir', () => {
    const dir = makeCodexHome();
    writeAuthFile(dir, JSON.stringify({ OPENAI_API_KEY: 'sk-xxx' }));

    const result = resolveCodexAuth({ CODEX_HOME: dir }, { homeDir: '/nonexistent-home' });

    expect(result.path).toBe(join(dir, 'auth.json'));
    expect(result.status).toBe('authenticated');
  });

  it('falls back to <homeDir>/.codex/auth.json when CODEX_HOME is unset', () => {
    const home = homeRoot;
    const defaultDir = join(home, '.codex');
    mkdirSync(defaultDir, { recursive: true });
    writeAuthFile(defaultDir, JSON.stringify({ OPENAI_API_KEY: 'sk-xxx' }));

    const result = resolveCodexAuth({}, { homeDir: home });

    expect(result.path).toBe(join(defaultDir, 'auth.json'));
    expect(result.status).toBe('authenticated');
  });
});

// ---------------------------------------------------------------------------
// CodexCliTransport refuses to dispatch with a CLASSIFIED retriable auth error
// ---------------------------------------------------------------------------

describe('CodexCliTransport auth precheck', () => {
  it('throws a retriable CodexAuthError and does NOT dispatch when unauthenticated', async () => {
    const dir = makeCodexHome(); // no auth.json => missing
    const transport = new CodexCliTransport({
      env: { CODEX_HOME: dir },
      authResolver: (env) => resolveCodexAuth(env),
    });

    const invokeSpy = vi.spyOn(
      transport as unknown as { invokeCodexCli: (...a: unknown[]) => unknown },
      'invokeCodexCli',
    );

    const error = await transport.execute(makeRequest()).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CodexAuthError);
    expect((error as CodexAuthError).retryable).toBe(true);
    expect(invokeSpy).not.toHaveBeenCalled();
  });

  it('dispatches normally when the auth resolver reports authenticated', async () => {
    const dir = makeCodexHome();
    writeAuthFile(dir, JSON.stringify({ OPENAI_API_KEY: 'sk-xxx' }));
    const transport = new CodexCliTransport({
      env: { CODEX_HOME: dir },
      authResolver: (env) => resolveCodexAuth(env),
    });

    vi.spyOn(
      transport as unknown as { invokeCodexCli: (...a: unknown[]) => unknown },
      'invokeCodexCli',
    ).mockResolvedValue({
      stdout: '',
      stderr: '',
      outputText: 'ok',
      durationMs: 5,
    });

    const result = await transport.execute(makeRequest());
    expect(result.response).toBe('ok');
  });

  it('does not precheck (preserves legacy behavior) when no authResolver is injected', async () => {
    const transport = new CodexCliTransport();
    vi.spyOn(
      transport as unknown as { invokeCodexCli: (...a: unknown[]) => unknown },
      'invokeCodexCli',
    ).mockResolvedValue({
      stdout: '',
      stderr: '',
      outputText: 'legacy',
      durationMs: 5,
    });

    const result = await transport.execute(makeRequest());
    expect(result.response).toBe('legacy');
  });
});
