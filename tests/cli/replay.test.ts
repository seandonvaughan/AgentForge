import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCliProgram } from '../../packages/cli/src/bin.js';

let testDir: string;
let capturedOutput: string;
let originalLog: any;

beforeEach(() => {
  testDir = join(tmpdir(), `agentforge-test-${Date.now()}`);
  mkdirSync(join(testDir, '.agentforge', 'memory'), { recursive: true });
  capturedOutput = '';

  originalLog = console.log;
  console.log = (...args: any[]) => {
    capturedOutput += args.map(a => String(a)).join(' ') + '\n';
  };
});

afterEach(() => {
  console.log = originalLog;
  if (existsSync(testDir)) {
    rmSync(testDir, { recursive: true, force: true });
  }
});

describe('replay command', () => {
  describe('step-scores', () => {
    it('should exit 0 with missing file gracefully', async () => {
      const program = createCliProgram();
      await program.parseAsync(['node', 'test', 'replay', 'step-scores', '--project-root', testDir]);

      expect(capturedOutput).toContain('No step-score replay data found');
      expect(process.exitCode).not.toBe(1);
    });

    it('should read and aggregate step-scores from jsonl', async () => {
      const ledgerPath = join(testDir, '.agentforge', 'memory', 'step-scores.jsonl');
      const now = new Date().toISOString();
      const entries = [
        { timestamp: now, agent_id: 'agent-a', capability_tag: 'tag-1', step_score: 0.5, cost_usd: 0.01 },
        { timestamp: now, agent_id: 'agent-a', capability_tag: 'tag-1', step_score: 0.6, cost_usd: 0.02 },
        { timestamp: now, agent_id: 'agent-b', capability_tag: 'tag-2', step_score: 0.8, cost_usd: 0.03 },
      ];

      for (const entry of entries) {
        writeFileSync(ledgerPath, JSON.stringify(entry) + '\n', { flag: 'a' });
      }

      const program = createCliProgram();
      await program.parseAsync(['node', 'test', 'replay', 'step-scores', '--project-root', testDir]);

      expect(capturedOutput).toContain('Step-Score Replay');
      expect(capturedOutput).toContain('agent-a');
      expect(capturedOutput).toContain('tag-1');
      expect(capturedOutput).toContain('agent-b');
      expect(capturedOutput).toContain('tag-2');
    });

    it('should filter by time period with --since', async () => {
      const ledgerPath = join(testDir, '.agentforge', 'memory', 'step-scores.jsonl');
      const now = new Date();
      const twoWeeksAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString();
      const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000).toISOString();

      const entries = [
        { timestamp: twoWeeksAgo, agent_id: 'agent-old', capability_tag: 'tag-old', step_score: 0.5, cost_usd: 0.01 },
        { timestamp: oneHourAgo, agent_id: 'agent-new', capability_tag: 'tag-new', step_score: 0.7, cost_usd: 0.02 },
      ];

      for (const entry of entries) {
        writeFileSync(ledgerPath, JSON.stringify(entry) + '\n', { flag: 'a' });
      }

      const program = createCliProgram();
      await program.parseAsync(['node', 'test', 'replay', 'step-scores', '--since', '7d', '--project-root', testDir]);

      expect(capturedOutput).toContain('agent-new');
      expect(capturedOutput).not.toContain('agent-old');
    });

    it('should output JSON with --json flag', async () => {
      const ledgerPath = join(testDir, '.agentforge', 'memory', 'step-scores.jsonl');
      const now = new Date().toISOString();
      const entry = { timestamp: now, agent_id: 'agent-test', capability_tag: 'tag-test', step_score: 0.65, cost_usd: 0.02 };

      writeFileSync(ledgerPath, JSON.stringify(entry) + '\n');

      const program = createCliProgram();
      const outputBefore = capturedOutput.length;
      await program.parseAsync(['node', 'test', 'replay', 'step-scores', '--json', '--project-root', testDir]);

      const output = capturedOutput.slice(outputBefore);
      const jsonMatch = output.match(/\{[\s\S]*\}/);
      expect(jsonMatch).toBeTruthy();

      const parsed = JSON.parse(jsonMatch![0]);
      expect(parsed.results).toBeDefined();
      expect(Array.isArray(parsed.results)).toBe(true);
      expect(parsed.results.length).toBeGreaterThan(0);
      expect(parsed.results[0]).toHaveProperty('agent_id');
      expect(parsed.results[0]).toHaveProperty('capability_tag');
      expect(parsed.results[0]).toHaveProperty('p50');
      expect(parsed.results[0]).toHaveProperty('p95');
    });

    it('should compute percentiles correctly', async () => {
      const ledgerPath = join(testDir, '.agentforge', 'memory', 'step-scores.jsonl');
      const now = new Date().toISOString();

      // Create 10 scores: 0.1, 0.2, ..., 1.0
      for (let i = 1; i <= 10; i++) {
        const entry = {
          timestamp: now,
          agent_id: 'agent-test',
          capability_tag: 'tag-test',
          step_score: i * 0.1,
          cost_usd: 0.01,
        };
        writeFileSync(ledgerPath, JSON.stringify(entry) + '\n', { flag: 'a' });
      }

      const program = createCliProgram();
      const outputBefore = capturedOutput.length;
      await program.parseAsync(['node', 'test', 'replay', 'step-scores', '--json', '--project-root', testDir]);

      const output = capturedOutput.slice(outputBefore);
      const jsonMatch = output.match(/\{[\s\S]*\}/);
      const parsed = JSON.parse(jsonMatch![0]);

      const result = parsed.results[0];
      expect(result.count).toBe(10);
      expect(result.p50).toBeCloseTo(0.6, 0);
      expect(result.p95).toBe(1.0);
    });
  });
});
