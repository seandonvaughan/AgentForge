import type { GuardrailViolation } from './types.js';

type Operation = string;

const BLOCKED_PATTERNS: Array<{ pattern: RegExp; rule: string; reason: string }> = [
  { pattern: /delete.*package/i, rule: 'no-package-deletion', reason: 'Deleting packages requires elevated approval — could break the monorepo' },
  { pattern: /rm\s+-rf/i, rule: 'no-recursive-delete', reason: 'Recursive deletion is a destructive operation requiring human review' },
  { pattern: /remove.*test/i, rule: 'no-test-removal', reason: 'Removing tests reduces coverage — requires approval' },
  { pattern: /drop.*table/i, rule: 'no-table-drop', reason: 'Dropping database tables is irreversible without a backup' },
  { pattern: /force.*push/i, rule: 'no-force-push', reason: 'Force pushing can destroy git history' },
  { pattern: /modify.*circuit.?breaker/i, rule: 'no-safety-system-modification', reason: 'Core safety systems require elevated approval' },
  { pattern: /disable.*guardrail/i, rule: 'no-guardrail-bypass', reason: 'Guardrails protect system integrity' },
];

export class Guardrails {
  /**
   * Check whether an operation is allowed.
   * Returns a GuardrailViolation if blocked, null if allowed.
   */
  check(operation: Operation): GuardrailViolation | null {
    for (const { pattern, rule, reason } of BLOCKED_PATTERNS) {
      if (pattern.test(operation)) {
        return { rule, operation, blocked: true, reason };
      }
    }
    return null;
  }

  /**
   * Assert an operation is allowed. Throws if blocked.
   */
  assert(operation: Operation): void {
    const violation = this.check(operation);
    if (violation) {
      throw new GuardrailError(violation);
    }
  }

  listRules(): Array<{ rule: string; reason: string }> {
    return BLOCKED_PATTERNS.map(({ rule, reason }) => ({ rule, reason }));
  }
}

export class GuardrailError extends Error {
  readonly code = 'GUARDRAIL_VIOLATION';
  readonly violation: GuardrailViolation;

  constructor(violation: GuardrailViolation) {
    super(`Guardrail '${violation.rule}' blocked: ${violation.reason}`);
    this.name = 'GuardrailError';
    this.violation = violation;
  }
}
