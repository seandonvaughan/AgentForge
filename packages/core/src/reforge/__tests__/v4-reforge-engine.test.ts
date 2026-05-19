import { describe, it, expect, beforeEach } from 'vitest';
import {
  InMemoryFileAdapter,
  InMemoryGitAdapter,
  InMemoryTestRunner,
  V4ReforgeEngine,
} from '../index.js';

const BASE_FILE = 'agent.yaml';

function buildEngine() {
  const files = new InMemoryFileAdapter();
  const git = new InMemoryGitAdapter();
  const testRunner = new InMemoryTestRunner();
  const engine = new V4ReforgeEngine({ files, git, testRunner });

  return { engine, files, git, testRunner };
}

describe('V4ReforgeEngine', () => {
  let engine: V4ReforgeEngine;
  let files: InMemoryFileAdapter;
  let git: InMemoryGitAdapter;
  let testRunner: InMemoryTestRunner;

  beforeEach(() => {
    ({ engine, files, git, testRunner } = buildEngine());
  });

  it('rejects a self-modification before apply when a guardrail fails', () => {
    engine = new V4ReforgeEngine({
      files,
      git,
      testRunner,
      guardrails: [
        {
          name: 'deny-broad-mutation',
          validate: () => ({ pass: false, reason: 'mutation scope is too broad' }),
        },
      ],
    });

    files.writeFile(BASE_FILE, 'original: true');

    const submitted = engine.submit({
      proposalId: 'proposal-1',
      description: 'update agent config',
      targetFile: BASE_FILE,
      changeType: 'modify',
      diff: 'patched: true',
      proposedBy: 'test-suite',
      rationale: 'regression gate',
    });

    const evaluated = engine.evaluate(submitted.proposal.proposalId);

    expect(evaluated.status).toBe('rejected');
    expect(evaluated.guardrailResults).toEqual([
      {
        name: 'deny-broad-mutation',
        pass: false,
        reason: 'mutation scope is too broad',
      },
    ]);
    expect(files.readFile(BASE_FILE)).toBe('original: true');
    expect(() => engine.apply(submitted.proposal.proposalId)).toThrow(/must be approved/i);
  });

  it('auto-rolls back a failed verification and restores the original file', () => {
    files.writeFile(BASE_FILE, 'original: true');
    testRunner.result = { pass: false, output: 'vitest detected a regression' };

    const submitted = engine.submit({
      proposalId: 'proposal-2',
      description: 'update agent config',
      targetFile: BASE_FILE,
      changeType: 'modify',
      diff: 'patched: true',
      proposedBy: 'test-suite',
      rationale: 'regression gate',
    });

    engine.evaluate(submitted.proposal.proposalId);
    const applied = engine.apply(submitted.proposal.proposalId);
    const verified = engine.verify(submitted.proposal.proposalId);

    expect(applied.snapshotTag).toMatch(/^reforge-proposal-2-/);
    expect(verified.status).toBe('rolled_back');
    expect(verified.testOutput).toBe('vitest detected a regression');
    expect(files.readFile(BASE_FILE)).toBe('original: true');
    expect(git.tagExists(applied.snapshotTag)).toBe(false);
    expect(engine.getHistory(submitted.proposal.proposalId).map((h) => h.status)).toEqual([
      'pending',
      'approved',
      'applied',
      'rolled_back',
    ]);
  });

  it('rolls back stale applied proposals when the timeout gate trips', () => {
    const submitted = engine.submit({
      proposalId: 'proposal-3',
      description: 'create new override file',
      targetFile: 'new-agent.yaml',
      changeType: 'create',
      diff: 'name: new-agent',
      proposedBy: 'test-suite',
      rationale: 'timeout gate',
    });

    engine.evaluate(submitted.proposal.proposalId);
    const applied = engine.apply(submitted.proposal.proposalId);
    engine._setAppliedAtForTest(submitted.proposal.proposalId, Date.now() - 121_000);

    const rolledBack = engine.checkTimeouts();

    expect(rolledBack).toEqual([submitted.proposal.proposalId]);
    expect(engine.getProposal(submitted.proposal.proposalId)?.status).toBe('rolled_back');
    expect(files.fileExists('new-agent.yaml')).toBe(false);
    expect(git.tagExists(applied.snapshotTag)).toBe(false);
  });
});
