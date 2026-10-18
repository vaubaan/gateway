/**
 * Secret references.
 *
 * - In the YAML file, any string may contain `${NAME}` (value of the
 *   environment variable `NAME`) or `${file:/path}` (trimmed content of a
 *   file, e.g. a Docker secret). Unset variables and unreadable files are
 *   configuration errors naming the key.
 * - In the environment, every secret-bearing variable `X` accepts a sibling
 *   `X_FILE` whose value is a path to read the secret from.
 */
import { readFileSync } from 'node:fs';

import { errorMessage, type IssueList } from './errors';

export type EnvSource = Readonly<Record<string, string | undefined>>;
export type FileReader = (path: string) => string;

export const defaultFileReader: FileReader = (path) => readFileSync(path, 'utf8');

/**
 * A secret file named by the configuration that does not exist (`ENOENT`): the key
 * it was to fill, the variable or file that named it, and the problem as it would
 * be reported. Recorded instead of reported when the reader is given a list for it:
 * the loader then decides whether the absence is tolerated (the master key file the
 * instance generates at its first start) or an error like any other.
 */
export interface AbsentSecretFile {
  readonly keyPath: string;
  readonly filePath: string;
  readonly env: readonly string[];
  readonly message: string;
}

/**
 * What a source reader notes beside the tree, for the loader: the secret files it
 * read a whole value from (`keyPath → file path`), and the ones that do not exist.
 */
export interface SourceTrace {
  readonly secretFiles: Map<string, string>;
  readonly absentFiles: AbsentSecretFile[];
}

export function newSourceTrace(): SourceTrace {
  return { secretFiles: new Map(), absentFiles: [] };
}

/** What every source reader needs: where values come from, where problems go. */
export interface SourceContext {
  readonly env: EnvSource;
  readonly readFile: FileReader;
  readonly issues: IssueList;
  /** When present, an absent secret file is recorded here instead of being reported. */
  readonly trace?: SourceTrace;
}

/** Whether a `readFile` failure says the file does not exist (as opposed to unreadable). */
export function isFileAbsent(err: unknown): boolean {
  if (typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT')
    return true;
  return errorMessage(err).startsWith('ENOENT');
}

function reportSecretFileProblem(
  ctx: SourceContext,
  keyPath: string,
  filePath: string,
  env: readonly string[],
  err: unknown,
): void {
  const message = `cannot read secret file "${filePath}": ${errorMessage(err)}`;
  if (ctx.trace && isFileAbsent(err)) {
    ctx.trace.absentFiles.push({ keyPath, filePath, env, message });
    return;
  }
  ctx.issues.add(keyPath, message, env);
}

/** `${file:/path}` as the whole value: the key is read from that one file. */
const WHOLE_FILE_REF = /^\s*\$\{file:([^}]+)\}\s*$/;

const REF = /\$\{(file:([^}]+)|([A-Za-z_][A-Za-z0-9_]*))\}/g;
/** Anything that still looks like a reference after resolution is a syntax the loader does not support. */
const UNSUPPORTED_REF = /\$\{[^}]*\}/;

/** Resolves every `${...}` reference of a scalar read from the YAML file. */
export function resolveRefs(ctx: SourceContext, value: string, keyPath: string): string {
  const whole = WHOLE_FILE_REF.exec(value)?.[1];
  if (whole !== undefined) ctx.trace?.secretFiles.set(keyPath, whole);
  const resolved = value.replace(
    REF,
    (_whole, _inner: string, filePath?: string, varName?: string) => {
      if (filePath !== undefined) {
        try {
          return ctx.readFile(filePath).trim();
        } catch (err) {
          reportSecretFileProblem(ctx, keyPath, filePath, [], err);
          return '';
        }
      }
      const fromEnv = varName === undefined ? undefined : ctx.env[varName];
      if (fromEnv === undefined) {
        ctx.issues.add(keyPath, `references \${${varName ?? ''}} but that variable is not set`);
        return '';
      }
      return fromEnv;
    },
  );
  if (UNSUPPORTED_REF.test(resolved)) {
    ctx.issues.add(
      keyPath,
      'contains an unsupported ${...} reference; only ${NAME} and ${file:/path} are resolved',
    );
  }
  return resolved;
}

/**
 * Reads an environment variable that may also be given as `<NAME>_FILE`.
 * Returns `undefined` when neither is set.
 */
export function readEnvSecret(
  ctx: SourceContext,
  name: string,
  keyPath: string,
): string | undefined {
  const direct = ctx.env[name];
  const fileVar = `${name}_FILE`;
  const filePath = ctx.env[fileVar];
  if (direct !== undefined && filePath !== undefined) {
    ctx.issues.add(keyPath, `set either ${name} or ${fileVar}, not both`, [name, fileVar]);
    return direct;
  }
  if (direct !== undefined) return direct;
  if (filePath === undefined) return undefined;
  try {
    const value = ctx.readFile(filePath).trim();
    ctx.trace?.secretFiles.set(keyPath, filePath);
    return value;
  } catch (err) {
    reportSecretFileProblem(ctx, keyPath, filePath, [fileVar], err);
    return undefined;
  }
}
