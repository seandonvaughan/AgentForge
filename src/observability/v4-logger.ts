/**
 * V4Logger — v4.1 P1-5
 *
 * Structured logging with module prefix and level filtering.
 * Zero external dependencies. Tree-shakeable per module.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  module: string;
  message: string;
  context?: Record<string, unknown>;
}

export type LogSink = (entry: LogEntry) => void;

const consoleSink: LogSink = (entry) => {
  const prefix = `[${entry.module}]`;
  const ctx = entry.context ? ` ${JSON.stringify(entry.context)}` : "";
  const msg = `${entry.timestamp} ${entry.level.toUpperCase().padEnd(5)} ${prefix} ${entry.message}${ctx}`;
  switch (entry.level) {
    case "error": console.error(msg); break;
    case "warn": console.warn(msg); break;
    case "debug": console.debug(msg); break;
    default: console.log(msg);
  }
};

let globalMinLevel: LogLevel = "info";
let globalSink: LogSink = consoleSink;
const moduleOverrides = new Map<string, LogLevel>();

export function setGlobalLogLevel(level: LogLevel): void {
  globalMinLevel = level;
}

export function setGlobalLogSink(sink: LogSink): void {
  globalSink = sink;
}

export function setModuleLogLevel(module: string, level: LogLevel): void {
  moduleOverrides.set(module, level);
}

export class V4Logger {
  constructor(private readonly module: string) {}

  debug(message: string, context?: Record<string, unknown>): void {
    this.log("debug", message, context);
  }

  info(message: string, context?: Record<string, unknown>): void {
    this.log("info", message, context);
  }

  warn(message: string, context?: Record<string, unknown>): void {
    this.log("warn", message, context);
  }

  error(message: string, context?: Record<string, unknown>): void {
    this.log("error", message, context);
  }

  private log(level: LogLevel, message: string, context?: Record<string, unknown>): void {
    const minLevel = moduleOverrides.get(this.module) ?? globalMinLevel;
    if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      module: this.module,
      message,
      context,
    };
    globalSink(entry);
  }
}
