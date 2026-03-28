/** Adversarial Testing Framework types */

export type EdgeCaseCategory =
  | 'boundary'      // Min/max values, empty inputs
  | 'injection'     // Special characters, SQL/script injection attempts
  | 'concurrency'   // Race conditions, high-load scenarios
  | 'malformed'     // Bad JSON, missing required fields
  | 'overflow'      // Very large inputs
  | 'unicode'       // Unicode edge cases, emoji, RTL text
  | 'null_like'     // null, undefined, NaN, Infinity
  | 'type_coercion' // Values that behave differently on type coercion
  | 'custom';

export type ChaosType =
  | 'latency'       // Inject artificial delay
  | 'error'         // Force an error response
  | 'timeout'       // Simulate timeout
  | 'partial'       // Return partial/corrupted data
  | 'unavailable';  // Service unavailable

export interface EdgeCaseInput {
  id: string;
  category: EdgeCaseCategory;
  name: string;
  value: unknown;
  description: string;
  expectedBehavior: 'reject' | 'handle_gracefully' | 'return_default';
}

export interface ChaosScenario {
  id: string;
  type: ChaosType;
  targetComponent: string;
  probability: number; // 0-1 chance of triggering
  delayMs?: number;    // For latency type
  errorMessage?: string;
  active: boolean;
  createdAt: string;
}

export interface AdversarialTestResult {
  scenarioId: string;
  input: EdgeCaseInput;
  passed: boolean;
  actualBehavior: string;
  errorThrown?: string;
  durationMs: number;
  timestamp: string;
}

export interface RegressionGateResult {
  passed: boolean;
  testsBefore: number;
  testsAfter: number;
  delta: number;
  failuresBefore: number;
  failuresAfter: number;
  failureDelta: number;
  reason?: string;
  blockedAt?: string;
}

export interface GenerateEdgeCasesOptions {
  categories?: EdgeCaseCategory[];
  count?: number;
  fieldName?: string;
  fieldType?: 'string' | 'number' | 'object' | 'array';
}
