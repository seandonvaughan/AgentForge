/**
 * V4Error Hierarchy — v4.1 P1-6
 *
 * Custom error classes with module codes and serializable context.
 * Pattern: MODULE.CATEGORY.SPECIFIC (e.g., BUS.PUBLISH.TOPIC_NOT_FOUND)
 */

export class V4Error extends Error {
  readonly module: string;
  readonly code: string;
  readonly context: Record<string, unknown>;

  constructor(module: string, code: string, message: string, context: Record<string, unknown> = {}) {
    super(message);
    this.name = "V4Error";
    this.module = module;
    this.code = code;
    this.context = context;
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      module: this.module,
      code: this.code,
      message: this.message,
      context: this.context,
    };
  }
}

export class BusError extends V4Error {
  constructor(code: string, message: string, context: Record<string, unknown> = {}) {
    super("bus", `BUS.${code}`, message, context);
    this.name = "BusError";
  }
}

export class ReforgeError extends V4Error {
  constructor(code: string, message: string, context: Record<string, unknown> = {}) {
    super("reforge", `REFORGE.${code}`, message, context);
    this.name = "ReforgeError";
  }
}

export class MemoryError extends V4Error {
  constructor(code: string, message: string, context: Record<string, unknown> = {}) {
    super("memory", `MEMORY.${code}`, message, context);
    this.name = "MemoryError";
  }
}

export class SessionError extends V4Error {
  constructor(code: string, message: string, context: Record<string, unknown> = {}) {
    super("session", `SESSION.${code}`, message, context);
    this.name = "SessionError";
  }
}

export class OrgGraphError extends V4Error {
  constructor(code: string, message: string, context: Record<string, unknown> = {}) {
    super("org-graph", `ORG.${code}`, message, context);
    this.name = "OrgGraphError";
  }
}

export class DelegationError extends V4Error {
  constructor(code: string, message: string, context: Record<string, unknown> = {}) {
    super("delegation", `DELEGATION.${code}`, message, context);
    this.name = "DelegationError";
  }
}

export class RegistryError extends V4Error {
  constructor(code: string, message: string, context: Record<string, unknown> = {}) {
    super("registry", `REGISTRY.${code}`, message, context);
    this.name = "RegistryError";
  }
}

export class FlywheelError extends V4Error {
  constructor(code: string, message: string, context: Record<string, unknown> = {}) {
    super("flywheel", `FLYWHEEL.${code}`, message, context);
    this.name = "FlywheelError";
  }
}

export class StorageError extends V4Error {
  constructor(code: string, message: string, context: Record<string, unknown> = {}) {
    super("storage", `STORAGE.${code}`, message, context);
    this.name = "StorageError";
  }
}
