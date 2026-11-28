/**
 * `readEnvSource()` — the `VAUBAAN_*` environment variables (with `*_FILE` siblings
 * for secrets) read into a raw tree shaped like the YAML file.
 */
import type { IssueList } from './errors';
import { NAMED_BLOCKS, parseNamedBlockEnvName, type NamedBlock } from './named-blocks';
import {
  type EnvSource,
  type FileReader,
  type SourceContext,
  type SourceTrace,
  defaultFileReader,
  readEnvSecret,
} from './secret-refs';
import { KEYS, type KeySpec } from './sources';
import { parseBool, setPath, splitList, type RawTree } from './tree';

export function readEnvSource(
  env: EnvSource,
  issues: IssueList,
  readFile: FileReader = defaultFileReader,
  trace?: SourceTrace,
): RawTree {
  const ctx: SourceContext = { env, readFile, issues, trace };
  const tree: RawTree = {};
  for (const spec of KEYS) {
    const value = readEnvValue(ctx, spec);
    if (value !== undefined) setPath(tree, spec.path, value);
  }
  readNamedBlocksEnv(ctx, tree);
  return tree;
}

export function readEnvValue(ctx: SourceContext, spec: KeySpec): unknown {
  if (spec.kind === 'secret' || spec.kind === 'secret-map') {
    const raw = readEnvSecret(ctx, spec.env, spec.path);
    if (raw === undefined) return undefined;
    return spec.kind === 'secret' ? raw : parseSecretMap(ctx, raw, spec);
  }
  const raw = ctx.env[spec.env];
  if (raw === undefined) return undefined;
  switch (spec.kind) {
    case 'string':
      return raw;
    case 'list':
      return splitList(raw);
    case 'int': {
      const n = raw.trim() === '' ? Number.NaN : Number(raw.trim());
      if (!Number.isInteger(n)) {
        ctx.issues.add(spec.path, `expected an integer, got "${raw}"`, [spec.env]);
        return undefined;
      }
      return n;
    }
    case 'bool': {
      const b = parseBool(raw);
      if (b === undefined)
        ctx.issues.add(spec.path, `expected true or false, got "${raw}"`, [spec.env]);
      return b;
    }
  }
}

/** `1=<base64>,2=<base64>` → `{ "1": "<base64>", "2": "<base64>" }`. The entries
 *  are secrets: a malformed one is reported by position, never echoed. */
function parseSecretMap(ctx: SourceContext, raw: string, spec: KeySpec): RawTree | undefined {
  const out: RawTree = {};
  const entries = splitList(raw);
  for (const [i, entry] of entries.entries()) {
    const eq = entry.indexOf('=');
    const version = eq > 0 ? entry.slice(0, eq).trim() : '';
    // The version must be a bare integer: a base64 key pasted without `<version>=`
    // carries `=` padding and must not be split (and echoed) as if it were one.
    if (!/^\d+$/.test(version)) {
      ctx.issues.add(spec.path, `entry #${i + 1} is not of the form "<version>=<key>"`, [spec.env]);
      return undefined;
    }
    out[version] = entry.slice(eq + 1).trim();
  }
  return out;
}

/**
 * `<prefix><NAME>_<FIELD>[_FILE]` → `<top>.<name>.<field>`, for every family of
 * `NAMED_BLOCKS`. The field is matched as a suffix so that a name with a hyphen
 * (`acme-entra` → `ACME_ENTRA`) parses unambiguously.
 */
function readNamedBlocksEnv(ctx: SourceContext, tree: RawTree): void {
  for (const block of NAMED_BLOCKS) readNamedBlockEnv(ctx, tree, block);
}

function readNamedBlockEnv(ctx: SourceContext, tree: RawTree, block: NamedBlock): void {
  const seen = new Set<string>();
  for (const name of Object.keys(ctx.env).sort()) {
    if (!name.startsWith(block.prefix) || ctx.env[name] === undefined) continue;
    const base = name.endsWith('_FILE') ? name.slice(0, -'_FILE'.length) : name;
    if (seen.has(base)) continue;
    seen.add(base);
    const parsed = parseNamedBlockEnvName(block, base);
    if (!parsed) {
      ctx.issues.add(
        block.top,
        `${name} does not end with a known ${block.noun} field (${block.fields.map((f) => f.env).join(', ')})`,
        [name],
      );
      continue;
    }
    const path = `${block.top}.${parsed.name}.${parsed.spec.field}`;
    let value: unknown;
    switch (parsed.spec.kind) {
      case 'secret':
        value = readEnvSecret(ctx, base, path);
        break;
      case 'list':
        value = ctx.env[base] === undefined ? undefined : splitList(ctx.env[base] ?? '');
        break;
      case 'bool': {
        const raw = ctx.env[base] ?? '';
        value = parseBool(raw);
        if (value === undefined)
          ctx.issues.add(path, `expected true or false, got "${raw}"`, [base]);
        break;
      }
      case 'string':
        value = ctx.env[base];
        break;
    }
    if (value !== undefined) setPath(tree, path, value);
  }
}
