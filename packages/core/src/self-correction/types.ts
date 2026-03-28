export interface Checkpoint {
  id: string;
  sprintVersion: string;
  branch: string;
  testCount: number;
  failureCount: number;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export interface RegressionReport {
  detected: boolean;
  testCountBefore: number;
  testCountAfter: number;
  failuresBefore: number;
  failuresAfter: number;
  delta: number;
  reason?: string;
}

export interface GuardrailViolation {
  rule: string;
  operation: string;
  blocked: boolean;
  reason: string;
}
