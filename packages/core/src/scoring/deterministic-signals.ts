// packages/core/src/scoring/deterministic-signals.ts
//
// Computes the 9 rubric-v1 deterministic signals from a ScoreInput.
// No network calls. All IO is synchronous (readFileSync).
//
// CodeQL guards:
//  - No exec/execSync — no subprocess calls here.
//  - String.includes() used for user-controlled-input matching (no .* regex).
//  - cycleArtifactsDir is not user-supplied at runtime (cycle-internal path).

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RUBRIC_VERSION, getRubricWeight, type Signal } from './rubric-v1.js';
import type { ValidatedJsonOutput } from '../autonomous/phase-handlers/execute-phase.js';

// Re-export for consumers that want the inlined type without depending on shared
export type { ValidatedJsonOutput };

export interface DeterministicInput {
  validatedOutput: ValidatedJsonOutput;
  cycleArtifactsDir: string;
  ownsSubsystems: string[];
  capabilityTags: string[];
  skillIds: string[];
  cycleId: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readCycleJson(artifactsDir: string, cycleId: string): Record<string, unknown> | null {
  // Try <dir>/cycle.json or <dir>/<cycleId>/cycle.json
  const candidates = [
    join(artifactsDir, 'cycle.json'),
    join(artifactsDir, cycleId, 'cycle.json'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      try {
        return JSON.parse(readFileSync(p, 'utf-8')) as Record<string, unknown>;
      } catch {
        // malformed — skip
      }
    }
  }
  return null;
}

/** Serialise parsed output to a flat string for substring checks. No .* regexes. */
function flattenParsed(parsed: unknown): string {
  if (parsed === null || parsed === undefined) return '';
  if (typeof parsed === 'string') return parsed;
  try {
    return JSON.stringify(parsed);
  } catch {
    return String(parsed);
  }
}

/** Glob-like subsystem matching: treat each pattern as a prefix/substring match. */
function fileInSubsystems(filePath: string, patterns: string[]): boolean {
  if (patterns.length === 0) return true;
  for (const pattern of patterns) {
    // Use String.includes for user-controlled path checks — no ReDoS risk
    if (filePath.includes(pattern) || pattern.includes(filePath)) return true;
    // Also support simple glob prefix: "packages/core/**" → startsWith("packages/core/")
    const prefix = pattern.replace(/\/\*\*$/, '/').replace(/\/\*$/, '/');
    if (filePath.startsWith(prefix)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Signal computers
// ---------------------------------------------------------------------------

function computeSchemaValid(input: DeterministicInput): Signal {
  return {
    key: 'schema.valid',
    value: input.validatedOutput.ok ? 1 : 0,
    source: 'deterministic',
    weight: getRubricWeight('schema.valid'),
    note: input.validatedOutput.ok ? 'schema check passed' : (input.validatedOutput.validationError ?? 'schema check failed'),
  };
}

function computeRequiredFieldsPresent(input: DeterministicInput): Signal {
  const { parsed, ok } = input.validatedOutput;
  if (!ok || typeof parsed !== 'object' || parsed === null) {
    return {
      key: 'schema.required_fields_present',
      value: 0,
      source: 'deterministic',
      weight: getRubricWeight('schema.required_fields_present'),
      note: 'output invalid or non-object',
    };
  }

  const keys = Object.keys(parsed as Record<string, unknown>);
  // If we have at least one key, consider it 1.0; scoring of individual required
  // fields needs the JSON schema which is not in scope for the step-scorer input.
  // Approximate: ratio of non-null/non-undefined values / total keys.
  const record = parsed as Record<string, unknown>;
  const present = keys.filter((k) => record[k] !== null && record[k] !== undefined).length;
  const value = keys.length > 0 ? present / keys.length : 1;

  return {
    key: 'schema.required_fields_present',
    value,
    source: 'deterministic',
    weight: getRubricWeight('schema.required_fields_present'),
    note: `${present}/${keys.length} fields non-null`,
  };
}

function computeFilesInScope(input: DeterministicInput): Signal {
  const { parsed } = input.validatedOutput;
  const flat = flattenParsed(parsed);

  // Extract file paths from common output keys: files_changed, touched_files, etc.
  // Simple heuristic: look for lines that look like paths (contain '/' or '.ts' etc.)
  const filePaths: string[] = [];
  if (typeof parsed === 'object' && parsed !== null) {
    const record = parsed as Record<string, unknown>;
    for (const key of ['files_changed', 'touched_files', 'modified_files', 'files']) {
      const val = record[key];
      if (Array.isArray(val)) {
        for (const f of val) {
          if (typeof f === 'string') filePaths.push(f);
        }
      }
    }
  }

  if (filePaths.length === 0) {
    // Try extracting from raw text — find strings with slashes
    const matches = flat.match(/"([^"]*\/[^"]+)"/g);
    if (matches) {
      for (const m of matches) {
        const path = m.replace(/^"|"$/g, '');
        if (path.includes('.') && !path.includes('http')) filePaths.push(path);
      }
    }
  }

  if (filePaths.length === 0) {
    return {
      key: 'files.in_scope',
      value: 1,
      source: 'deterministic',
      weight: getRubricWeight('files.in_scope'),
      note: 'no file paths detected; assuming in-scope',
    };
  }

  const inScope = filePaths.filter((f) => fileInSubsystems(f, input.ownsSubsystems));
  const ratio = inScope.length / filePaths.length;

  return {
    key: 'files.in_scope',
    value: ratio,
    source: 'deterministic',
    weight: getRubricWeight('files.in_scope'),
    note: `${inScope.length}/${filePaths.length} files in scope`,
  };
}

function computeFileSizeSane(input: DeterministicInput): Signal {
  const isRefactor = input.capabilityTags.includes('refactor');
  const { parsed } = input.validatedOutput;
  const flat = flattenParsed(parsed);

  // Look for diff_lines or lines_changed indicators in output
  let maxDiff = 0;
  if (typeof parsed === 'object' && parsed !== null) {
    const record = parsed as Record<string, unknown>;
    for (const key of ['diff_lines', 'lines_changed', 'lines_added', 'loc_delta']) {
      const val = record[key];
      if (typeof val === 'number') maxDiff = Math.max(maxDiff, Math.abs(val));
    }
  }

  // Fallback: estimate from raw output size (very rough)
  if (maxDiff === 0) {
    // Count newlines in output as a proxy for changed lines
    const lineCount = (flat.match(/\\n/g) ?? []).length;
    maxDiff = lineCount;
  }

  const tooLarge = !isRefactor && maxDiff > 2000;

  return {
    key: 'files.size_sane',
    value: tooLarge ? 0 : 1,
    source: 'deterministic',
    weight: getRubricWeight('files.size_sane'),
    note: tooLarge ? `diff ~${maxDiff} LoC exceeds 2000 without refactor tag` : `size ok (~${maxDiff} lines)`,
  };
}

function computeTestsDeltaNonneg(input: DeterministicInput): Signal {
  const cycleJson = readCycleJson(input.cycleArtifactsDir, input.cycleId);

  if (!cycleJson) {
    return {
      key: 'tests.delta_nonneg',
      value: 0.5,
      source: 'deterministic',
      weight: getRubricWeight('tests.delta_nonneg'),
      note: 'cycle.json not found; neutral score',
    };
  }

  // Look for tests.passed or tests.delta
  const tests = cycleJson['tests'] as Record<string, number> | undefined;
  if (!tests) {
    return {
      key: 'tests.delta_nonneg',
      value: 0.5,
      source: 'deterministic',
      weight: getRubricWeight('tests.delta_nonneg'),
      note: 'no tests key in cycle.json; neutral',
    };
  }

  const delta = tests['delta'] ?? (tests['passed'] ?? 0) - (tests['previousPassed'] ?? 0);

  return {
    key: 'tests.delta_nonneg',
    value: delta >= 0 ? 1 : 0,
    source: 'deterministic',
    weight: getRubricWeight('tests.delta_nonneg'),
    note: `test delta: ${delta >= 0 ? '+' : ''}${delta}`,
  };
}

function computeTddRedGreen(input: DeterministicInput): Signal {
  if (!input.skillIds.includes('af-tdd')) {
    return {
      key: 'tdd.red_green_observed',
      value: 1,
      source: 'deterministic',
      weight: getRubricWeight('tdd.red_green_observed'),
      note: 'af-tdd not in skill_ids; criterion not applicable',
    };
  }

  const flat = flattenParsed(input.validatedOutput.parsed);
  const raw = input.validatedOutput.raw;
  const combined = flat + ' ' + raw;

  // Use String.includes — no ReDoS risk from user input
  const hasRed = combined.includes('red') || combined.includes('FAIL') || combined.includes('failing');
  const hasGreen = combined.includes('green') || combined.includes('PASS') || combined.includes('passing');

  const observed = hasRed && hasGreen;

  return {
    key: 'tdd.red_green_observed',
    value: observed ? 1 : 0,
    source: 'deterministic',
    weight: getRubricWeight('tdd.red_green_observed'),
    note: observed ? 'red→green TDD markers found' : 'TDD markers not found in output',
  };
}

function computeVerifyChecksRun(input: DeterministicInput): Signal {
  if (!input.skillIds.includes('af-verify-before-done')) {
    return {
      key: 'verify.checks_run',
      value: 1,
      source: 'deterministic',
      weight: getRubricWeight('verify.checks_run'),
      note: 'af-verify-before-done not in skill_ids; criterion not applicable',
    };
  }

  const flat = flattenParsed(input.validatedOutput.parsed);
  const raw = input.validatedOutput.raw;
  const combined = flat + ' ' + raw;

  // Use String.includes — no regex on user-controlled input
  const verified =
    combined.includes('verified') ||
    combined.includes('pnpm test') ||
    combined.includes('tsc --noEmit') ||
    combined.includes('tests pass') ||
    combined.includes('all tests') ||
    combined.includes('verification');

  return {
    key: 'verify.checks_run',
    value: verified ? 1 : 0,
    source: 'deterministic',
    weight: getRubricWeight('verify.checks_run'),
    note: verified ? 'verification evidence found' : 'no verification evidence in output',
  };
}

function computeOutputLengthSane(input: DeterministicInput): Signal {
  const len = input.validatedOutput.raw.length;
  const sane = len >= 50 && len <= 50000;

  return {
    key: 'output.length_sane',
    value: sane ? 1 : 0,
    source: 'deterministic',
    weight: getRubricWeight('output.length_sane'),
    note: `raw output length: ${len} chars`,
  };
}

function computeNoPlaceholders(input: DeterministicInput): Signal {
  const flat = flattenParsed(input.validatedOutput.parsed);

  // Use String.includes — safe for user-controlled content (no ReDoS)
  const hasPlaceholder =
    flat.includes('TODO') ||
    flat.includes('FIXME') ||
    flat.includes('placeholder');

  return {
    key: 'output.no_placeholder_strings',
    value: hasPlaceholder ? 0 : 1,
    source: 'deterministic',
    weight: getRubricWeight('output.no_placeholder_strings'),
    note: hasPlaceholder ? 'placeholder strings detected in output' : 'no placeholder strings',
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function computeDeterministicSignals(input: DeterministicInput): Signal[] {
  return [
    computeSchemaValid(input),
    computeRequiredFieldsPresent(input),
    computeFilesInScope(input),
    computeFileSizeSane(input),
    computeTestsDeltaNonneg(input),
    computeTddRedGreen(input),
    computeVerifyChecksRun(input),
    computeOutputLengthSane(input),
    computeNoPlaceholders(input),
  ];
}

export { RUBRIC_VERSION };
