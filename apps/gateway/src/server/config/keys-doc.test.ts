/**
 * Structural test: the key table of `docs/handbook/configuration.md`
 * ("Configuration keys") is the loader's key table, in both directions.
 *
 * Nothing is listed by hand here. The expected cells are derived from `KEYS`
 * (`sources.ts`), the table `load.ts` reads its defaults and bounds from:
 *
 * - every key of `KEYS` has one row, and every row is a key of `KEYS` or one
 *   of the named-block families (`sign_in.<id>.<field>`,
 *   `oauth_brokers.<name>.<field>`);
 * - the type, the default (or the requirement) and the bounds of a row are
 *   those of the key;
 * - the environment variables of a row are the ones that set the key.
 *
 * In the "Bounds" cell the text up to the first `;` is checked; what follows
 * is prose for the rules the table does not carry as data (a rule across two
 * keys, the format of a list entry). The "Consumed by" cell is prose and must
 * only be present.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  KEYS,
  OAUTH_BROKER_ENV_PREFIX,
  OAUTH_BROKER_FIELDS,
  SIGN_IN_ENV_PREFIX,
  SIGN_IN_FIELDS,
  envNamesFor,
  type KeySpec,
} from './sources';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const HANDBOOK = 'docs/handbook/configuration.md';
const SECTION = '## Configuration keys';
const COLUMNS = ['Key', 'Type', 'Default', 'Bounds', 'Environment variable', 'Consumed by'];
const SIGN_IN_FAMILY = 'sign_in.<id>.<field>';
const OAUTH_BROKER_FAMILY = 'oauth_brokers.<name>.<field>';
const NONE = '—';

interface Row {
  readonly key: string;
  readonly type: string;
  readonly default: string;
  readonly bounds: string;
  readonly env: string;
  readonly consumedBy: string;
}

function cellsOf(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

/** Inline code marks are presentation: `90` and 90 are the same value. */
function plain(cell: string): string {
  return cell.replace(/`/g, '').trim();
}

/** The first Markdown table after the section heading: its header and its rows. */
function readKeyTable(): { header: string[]; rows: Row[] } {
  const lines = readFileSync(resolve(REPO, HANDBOOK), 'utf8').split('\n');
  const start = lines.indexOf(SECTION);
  if (start < 0) throw new Error(`${HANDBOOK} has no "${SECTION}" section`);
  const first = lines.findIndex((line, i) => i > start && line.startsWith('|'));
  if (first < 0) throw new Error(`${HANDBOOK}: no table under "${SECTION}"`);
  const table: string[] = [];
  for (let i = first; i < lines.length && (lines[i] ?? '').startsWith('|'); i++) {
    table.push(lines[i] ?? '');
  }
  const [headerLine = '', , ...body] = table;
  const rows = body.map((line): Row => {
    const [key = '', type = '', def = '', bounds = '', env = '', consumedBy = ''] = cellsOf(line);
    return {
      key: plain(key),
      type: plain(type),
      default: plain(def),
      bounds: plain(bounds.split(';')[0] ?? ''),
      env,
      consumedBy,
    };
  });
  return { header: cellsOf(headerLine), rows };
}

function expectedType(spec: KeySpec): string {
  switch (spec.kind) {
    case 'int':
      return 'integer';
    case 'bool':
      return 'boolean';
    case 'list':
      return 'list';
    case 'secret':
      return 'secret';
    case 'secret-map':
      return 'secret map';
    case 'string':
      if (spec.format === 'url') return 'URL';
      return spec.format ?? 'string';
  }
}

function expectedDefault(spec: KeySpec): string {
  switch (spec.required) {
    case 'always':
      return 'required';
    case 'without-sign-in':
      return 'required while no sign-in provider is set';
    case undefined:
      return spec.default === undefined ? NONE : String(spec.default);
  }
}

function expectedBounds(spec: KeySpec): string {
  const parts: string[] = [];
  if (spec.https) parts.push('https');
  if (spec.min !== undefined) {
    parts.push(spec.max === undefined ? `>= ${spec.min}` : `${spec.min} to ${spec.max}`);
  }
  if (spec.maxSeconds !== undefined) parts.push(`at most ${spec.maxSeconds} s`);
  if (spec.oneOf) parts.push(spec.oneOf.join(', '));
  if (spec.minLength !== undefined && spec.maxLength !== undefined) {
    parts.push(`${spec.minLength} to ${spec.maxLength} characters`);
  } else if (spec.minLength !== undefined) {
    parts.push(`at least ${spec.minLength} characters`);
  } else if (spec.maxLength !== undefined) {
    parts.push(`at most ${spec.maxLength} characters`);
  }
  return parts.length === 0 ? NONE : parts.join(', ');
}

function variablesIn(cell: string): string[] {
  return [...new Set(cell.match(/VAUBAAN_[A-Z0-9_]+/g) ?? [])].sort();
}

describe('the key table of the configuration handbook', () => {
  const { header, rows } = readKeyTable();
  const documented = new Map(rows.map((row) => [row.key, row]));

  it('has the six columns the test reads', () => {
    expect(header).toEqual(COLUMNS);
  });

  it('lists each key once', () => {
    expect(rows.map((row) => row.key).sort()).toEqual([...documented.keys()].sort());
  });

  it('has a row for every key the loader accepts', () => {
    const missing = KEYS.map((k) => k.path).filter((path) => !documented.has(path));
    expect(missing).toEqual([]);
  });

  it('has no row the loader does not accept', () => {
    const known = new Set([...KEYS.map((k) => k.path), SIGN_IN_FAMILY, OAUTH_BROKER_FAMILY]);
    expect([...documented.keys()].filter((key) => !known.has(key))).toEqual([]);
  });

  it.each(KEYS.map((spec) => [spec.path, spec] as const))(
    '%s: type, default, bounds and variables are the loader’s',
    (path, spec) => {
      const row = documented.get(path);
      expect(row, `no row for ${path}`).toBeDefined();
      if (!row) return;
      expect({ type: row.type, default: row.default, bounds: row.bounds }).toEqual({
        type: expectedType(spec),
        default: expectedDefault(spec),
        bounds: expectedBounds(spec),
      });
      expect(variablesIn(row.env)).toEqual([...envNamesFor(path)].sort());
      expect(row.consumedBy).not.toBe('');
    },
  );

  it('documents the sign-in provider family with the fields and variables the loader accepts', () => {
    const row = documented.get(SIGN_IN_FAMILY);
    expect(row, `no row for ${SIGN_IN_FAMILY}`).toBeDefined();
    if (!row) return;
    expect(row.bounds).toBe(SIGN_IN_FIELDS.map((f) => f.field).join(', '));
    expect(plain(row.env)).toContain(`${SIGN_IN_ENV_PREFIX}<ID>_<FIELD>`);
    for (const field of SIGN_IN_FIELDS) expect(plain(row.env)).toContain(field.env);
    expect(row.consumedBy).not.toBe('');
  });

  it('documents the OAuth broker family with the fields and variables the loader accepts', () => {
    const row = documented.get(OAUTH_BROKER_FAMILY);
    expect(row, `no row for ${OAUTH_BROKER_FAMILY}`).toBeDefined();
    if (!row) return;
    expect(row.bounds).toBe(OAUTH_BROKER_FIELDS.map((f) => f.field).join(', '));
    expect(plain(row.env)).toContain(`${OAUTH_BROKER_ENV_PREFIX}<NAME>_<FIELD>`);
    for (const field of OAUTH_BROKER_FIELDS) expect(plain(row.env)).toContain(field.env);
    expect(row.consumedBy).not.toBe('');
  });
});
