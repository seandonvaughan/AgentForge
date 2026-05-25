import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCliProgram } from '../bin.js';

describe('agentforge skills catalog', () => {
  let consoleLog: ReturnType<typeof vi.spyOn>;
  let consoleError: ReturnType<typeof vi.spyOn>;
  let consoleWarn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    process.exitCode = undefined;
  });

  afterEach(() => {
    consoleLog.mockRestore();
    consoleError.mockRestore();
    consoleWarn.mockRestore();
    process.exitCode = undefined;
  });

  it('prints the skills catalog as read-only JSON metadata', async () => {
    const program = createCliProgram();
    program.exitOverride();

    await program.parseAsync(['skills', 'catalog', '--json'], { from: 'user' });

    expect(process.exitCode).toBeUndefined();
    expect(consoleError).not.toHaveBeenCalled();
    expect(consoleWarn).not.toHaveBeenCalled();

    const stdout = consoleLog.mock.calls.map((call: unknown[]) => String(call[0])).join('\n');
    const payload = JSON.parse(stdout) as Array<{
      id: string;
      version: string;
      tags: string[];
      appliesTo: string[];
      maxTokens: number;
      requiredTools: string[];
      filePath?: string;
      body?: string;
    }>;

    expect(payload).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'af-tdd',
          requiredTools: ['Bash', 'Write', 'Edit'],
        }),
        expect.objectContaining({
          id: 'af-verify-before-done',
          requiredTools: [],
        }),
      ]),
    );
    expect(payload.every((skill) => typeof skill.filePath === 'undefined')).toBe(true);
    expect(payload.every((skill) => typeof skill.body === 'undefined')).toBe(true);
    expect(payload.map((skill) => skill.id)).not.toContain('prop-refine-tdd-2024-01');
  });
});
