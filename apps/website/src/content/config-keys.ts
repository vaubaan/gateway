/**
 * The configuration keys of an instance, for the docs page "Configuration
 * keys". The source is the key table of `docs/handbook/configuration.md`,
 * which the gateway's own test (`apps/gateway/src/server/config/keys-doc.test.ts`)
 * holds to `KEYS`, the table the loader reads its defaults and bounds from.
 * The site therefore copies no key by hand: KEYS → handbook table → this page,
 * each arrow checked by a test (this site's `config-keys.test.ts` compares the
 * page with `KEYS` directly).
 */
import { markdownTable, tableUnder } from './markdown';

export const CONFIG_HANDBOOK = 'docs/handbook/configuration.md';
export const CONFIG_SECTION = '## Configuration keys';

/** The columns the handbook table carries, in order (the gateway's test pins them too). */
export const HANDBOOK_COLUMNS = [
  'Key',
  'Type',
  'Default',
  'Bounds',
  'Environment variable',
  'Consumed by',
] as const;

export interface ConfigKeyRow {
  /** The YAML path as written in the handbook, without code marks (`git.max_pack_mb`). */
  readonly key: string;
  readonly type: string;
  readonly default: string;
  readonly bounds: string;
  readonly env: string;
}

function plain(cell: string): string {
  return cell.replace(/`/g, '').trim();
}

/** Every row of the handbook's key table; throws when its columns change. */
export function parseConfigKeys(handbook: string): ConfigKeyRow[] {
  const { header, rows } = tableUnder(handbook, CONFIG_SECTION);
  if (header.join('|') !== HANDBOOK_COLUMNS.join('|')) {
    throw new Error(
      `${CONFIG_HANDBOOK}: the key table's columns changed (${header.join(', ')}); update the site's reader`,
    );
  }
  return rows.map(([key = '', type = '', def = '', bounds = '', env = '']) => ({
    key: plain(key),
    type,
    default: def,
    bounds,
    env,
  }));
}

/** The page's table: the key, how to set it, what it accepts. */
export function configKeysMarkdown(rows: readonly ConfigKeyRow[]): string {
  return markdownTable(
    ['Key', 'Environment variable', 'Type', 'Default', 'Accepted values'],
    rows.map((row) => [`\`${row.key}\``, row.env, row.type, row.default, row.bounds]),
  );
}
