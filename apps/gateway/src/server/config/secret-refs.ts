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

/** What every source reader needs: where values come from, where problems go. */
export interface SourceContext {
  readonly env: EnvSource;
  readonly readFile: FileReader;
  readonly issues: IssueList;
}

const REF = /\$\{(file:([^}]+)|([A-Za-z_][A-Za-z0-9_]*))\}/g;
/** Anything that still looks like a reference after resolution is a syntax the loader does not support. */
const UNSUPPORTED_REF = /\$\{[^}]*\}/;

/** Resolves every `${...}` reference of a scalar read from the YAML file. */
export function resolveRefs(ctx: SourceContext, value: string, keyPath: string): string {
  const resolved = value.replace(
    REF,
    (_whole, _inner: string, filePath?: string, varName?: string) => {
      if (filePath !== undefined) {
        try {
          return ctx.readFile(filePath).trim();
        } catch (err) {
          ctx.issues.add(keyPath, `cannot read secret file "${filePath}": ${errorMessage(err)}`);
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
    return ctx.readFile(filePath).trim();
  } catch (err) {
    ctx.issues.add(keyPath, `cannot read secret file "${filePath}": ${errorMessage(err)}`, [
      fileVar,
    ]);
    return undefined;
  }
}
