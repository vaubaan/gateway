/**
 * The broker's only output. One JSON line per event, on stdout. Callers pass
 * named, non-sensitive fields only: a route template, a status, a duration, a
 * count. Never a body, a URL with its query, a header, a token, a code, a
 * verifier or a key — there is no "message from an error" field either,
 * because an error raised by a library can quote what it was given.
 */
export type LogFields = Readonly<Record<string, string | number | boolean>>;

export interface Logger {
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
}

export function createLogger(
  write: (line: string) => void = (line) => process.stdout.write(line),
): Logger {
  const emit = (level: string, event: string, fields: LogFields = {}): void => {
    write(`${JSON.stringify({ time: new Date().toISOString(), level, event, ...fields })}\n`);
  };
  return {
    info: (event, fields) => emit('info', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
  };
}

/** The error's class name, and nothing it carries. */
export function errorKind(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
