/**
 * The renamed keys still read under their old name (`DEPRECATED_ALIASES`).
 */
import { readEnvValue } from './env-source';
import type { IssueList } from './errors';
import { defaultFileReader, type EnvSource } from './secret-refs';
import { keySpec, type KeyPath } from './sources';
import { getPath, setPath, type RawTree } from './tree';

/**
 * A key and its variable renamed: still read under the old name, the new one winning
 * when both are set, with one boot warning naming the new key (ADR
 * one-word-per-thing-account-service-plugin).
 */
export interface DeprecatedAlias {
  readonly old: string;
  readonly oldEnv: string;
  readonly current: KeyPath;
}

export const DEPRECATED_ALIASES: readonly DeprecatedAlias[] = [
  { old: 'limits.connections', oldEnv: 'VAUBAAN_LIMITS_CONNECTIONS', current: 'limits.accounts' },
];

/** An old name the configuration still uses, and the key it is read as. */
export interface DeprecatedKeyUse {
  /** As written: the file's key or the variable. */
  readonly old: string;
  /** The key to write instead (or its variable, for a variable). */
  readonly current: string;
}

/**
 * Reads the deprecated names into their current keys, in place: the file's old key
 * into the file's tree, the old variable into the environment's tree, each only where
 * the current name is absent. Returns every old name set, whether it was read or not.
 */
export function applyDeprecatedAliases(
  fromEnv: RawTree,
  fromFile: RawTree | null,
  env: EnvSource,
  issues: IssueList,
): DeprecatedKeyUse[] {
  const used: DeprecatedKeyUse[] = [];
  for (const alias of DEPRECATED_ALIASES) {
    const spec = keySpec(alias.current);
    if (env[alias.oldEnv] !== undefined) {
      used.push({ old: alias.oldEnv, current: spec.env });
      if (env[spec.env] === undefined) {
        const value = readEnvValue(
          { env, readFile: defaultFileReader, issues },
          { ...spec, env: alias.oldEnv },
        );
        if (value !== undefined) setPath(fromEnv, alias.current, value);
      }
    }
    const fileValue = fromFile ? getPath(fromFile, alias.old) : undefined;
    if (fromFile && fileValue !== undefined) {
      used.push({ old: alias.old, current: alias.current });
      if (getPath(fromFile, alias.current) === undefined) {
        setPath(fromFile, alias.current, fileValue);
      }
    }
  }
  return used;
}
