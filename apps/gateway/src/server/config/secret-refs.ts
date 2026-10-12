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

import type { IssueList } from './errors';

export type EnvSource = Readonly<Record<string, string | undefined>>;
export type FileReader = (path: string) => string;

export const defaultFileReader: FileReader = (path) => readFileSync(path, 'utf8');

const REF = /\$\{(file:([^}]+)|([A-Za-z_][A-Za-z0-9_]*))\}/g;

/** Resolves every `${...}` reference of a scalar read from the YAML file. */
export function resolveRefs(
  value: string,
  keyPath: string,
  env: EnvSource,
  readFile: FileReader,
  issues: IssueList,
): string {
  return value.replace(REF, (_whole, _inner: string, filePath?: string, varName?: string) => {
    if (filePath !== undefined) {
      try {
        return readFile(filePath).trim();
      } catch (err) {
        issues.add(keyPath, `cannot read secret file "${filePath}": ${describe(err)}`);
        return '';
      }
    }
    const resolved = varName === undefined ? undefined : env[varName];
    if (resolved === undefined) {
      issues.add(keyPath, `references \${${varName ?? ''}} but that variable is not set`);
      return '';
    }
    return resolved;
  });
}

/**
 * Reads an environment variable that may also be given as `<NAME>_FILE`.
 * Returns `undefined` when neither is set.
 */
export function readEnvSecret(
  name: string,
  keyPath: string,
  env: EnvSource,
  readFile: FileReader,
  issues: IssueList,
): string | undefined {
  const direct = env[name];
  const fileVar = `${name}_FILE`;
  const filePath = env[fileVar];
  if (direct !== undefined && filePath !== undefined) {
    issues.add(keyPath, `set either ${name} or ${fileVar}, not both`, [name, fileVar]);
    return direct;
  }
  if (direct !== undefined) return direct;
  if (filePath === undefined) return undefined;
  try {
    return readFile(filePath).trim();
  } catch (err) {
    issues.add(keyPath, `cannot read secret file "${filePath}": ${describe(err)}`, [fileVar]);
    return undefined;
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
