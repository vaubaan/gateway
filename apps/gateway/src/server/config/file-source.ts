/**
 * `readFileSource()` — the YAML file named by `VAUBAAN_CONFIG_FILE`, with `${NAME}` /
 * `${file:/path}` references resolved, read into a raw tree.
 */
import { parse as parseYaml } from 'yaml';

import { errorMessage, type IssueList } from './errors';
import {
  type EnvSource,
  type FileReader,
  type SourceContext,
  type SourceTrace,
  defaultFileReader,
  resolveRefs,
} from './secret-refs';
import { CONFIG_FILE_ENV, isSecretKeyPath } from './sources';
import { isPlainObject, type RawTree } from './tree';

export interface FileSourceResult {
  readonly tree: RawTree;
  /** Absolute or relative path that was read, for the boot log. */
  readonly path: string;
  /** Environment variables the file references (`${NAME}`) at a secret key. */
  readonly secretVariables: readonly string[];
}

/** What resolving the file needs beyond the source context: where secret references go. */
interface FileContext extends SourceContext {
  readonly secretVariables: Set<string>;
}

const VARIABLE_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * Reads the YAML file named by `VAUBAAN_CONFIG_FILE`. Returns `null` when the
 * variable is unset (environment-only configuration). A set variable that
 * points to an unreadable or invalid file is an error.
 */
export function readFileSource(
  env: EnvSource,
  issues: IssueList,
  readFile: FileReader = defaultFileReader,
  trace?: SourceTrace,
): FileSourceResult | null {
  const path = env[CONFIG_FILE_ENV];
  if (path === undefined || path.trim() === '') return null;
  const ctx: FileContext = { env, readFile, issues, trace, secretVariables: new Set() };
  let text: string;
  try {
    text = readFile(path);
  } catch (err) {
    issues.add(CONFIG_FILE_ENV, `cannot read "${path}": ${errorMessage(err)}`, [CONFIG_FILE_ENV]);
    return { tree: {}, path, secretVariables: [] };
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(text) as unknown;
  } catch (err) {
    issues.add(CONFIG_FILE_ENV, `"${path}" is not valid YAML: ${errorMessage(err)}`, [
      CONFIG_FILE_ENV,
    ]);
    return { tree: {}, path, secretVariables: [] };
  }
  if (parsed === null || parsed === undefined) return { tree: {}, path, secretVariables: [] };
  if (!isPlainObject(parsed)) {
    issues.add(CONFIG_FILE_ENV, `"${path}" must contain a YAML mapping at the top level`, [
      CONFIG_FILE_ENV,
    ]);
    return { tree: {}, path, secretVariables: [] };
  }
  const tree = resolveTree(ctx, parsed, '', new Set([parsed]));
  return { tree, path, secretVariables: [...ctx.secretVariables] };
}

/**
 * The nodes being resolved, from the root down: a YAML alias used inside its
 * own anchor (`a: &x [*x]`) parses to a value that contains itself, which
 * would recurse until the stack overflows. It is reported as an issue of its
 * key instead (found by the property tests of the loader).
 */
type Ancestors = ReadonlySet<object>;

function resolveTree(
  ctx: FileContext,
  node: RawTree,
  prefix: string,
  ancestors: Ancestors,
): RawTree {
  const out: RawTree = {};
  for (const [key, value] of Object.entries(node)) {
    const path = prefix ? `${prefix}.${key}` : key;
    // Assigned, `__proto__` would replace the prototype of `out` instead of
    // adding a key (a value with no prototype then breaks every message that
    // quotes it). No configuration key has that name.
    if (key === '__proto__') {
      ctx.issues.add(path, 'is not a configuration key', [CONFIG_FILE_ENV]);
      continue;
    }
    out[key] = resolveValue(ctx, value, path, ancestors);
  }
  return out;
}

function resolveValue(
  ctx: FileContext,
  value: unknown,
  path: string,
  ancestors: Ancestors,
): unknown {
  if (typeof value === 'string') {
    if (isSecretKeyPath(path)) {
      for (const match of value.matchAll(VARIABLE_REF)) {
        if (match[1] !== undefined) ctx.secretVariables.add(match[1]);
      }
    }
    return resolveRefs(ctx, value, path);
  }
  if (typeof value !== 'object' || value === null) return value;
  if (ancestors.has(value)) {
    ctx.issues.add(path, 'refers to itself (a YAML alias inside its own anchor)', [
      CONFIG_FILE_ENV,
    ]);
    return undefined;
  }
  const inside = new Set(ancestors).add(value);
  if (Array.isArray(value)) {
    return value.map((item, i) => resolveValue(ctx, item, `${path}[${i}]`, inside));
  }
  if (isPlainObject(value)) return resolveTree(ctx, value, path, inside);
  return value;
}
