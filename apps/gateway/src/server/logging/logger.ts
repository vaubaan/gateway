/**
 * Structured logger: one JSON object per line on stdout (stderr for
 * `error`), redacted as a whole line so a secret hidden in any field is
 * caught. Dependency-free on purpose; a pino-style sink can replace `write`
 * later without touching call sites.
 */
import type { LogLevel } from '../config/types';
import { type Redactor } from './redact';

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(bindings: LogFields): Logger;
}

export interface LoggerOptions {
  readonly level: LogLevel;
  readonly redact: Redactor;
  /** Receives the final line (with trailing newline). Defaults to stdout/stderr. */
  readonly write?: (level: LogLevel, line: string) => void;
  readonly now?: () => Date;
}

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const defaultWrite = (level: LogLevel, line: string): void => {
  (level === 'error' ? process.stderr : process.stdout).write(line);
};

export function createLogger(options: LoggerOptions, bindings: LogFields = {}): Logger {
  const write = options.write ?? defaultWrite;
  const now = options.now ?? (() => new Date());
  const threshold = ORDER[options.level];

  function emit(level: LogLevel, message: string, fields?: LogFields): void {
    if (ORDER[level] < threshold) return;
    // Reserved keys last: a field named `level` or `msg` must not overwrite them.
    const record = { ...bindings, ...fields, time: now().toISOString(), level, msg: message };
    write(level, options.redact(JSON.stringify(record, errorReplacer)) + '\n');
  }

  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (more) => createLogger(options, { ...bindings, ...more }),
  };
}

function errorReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  return value;
}

/** A logger that drops everything; for tests and for code paths before boot. */
export const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
};
