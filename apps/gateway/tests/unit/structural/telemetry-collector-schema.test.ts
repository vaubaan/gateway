/**
 * Structural test: the collector's schema (`deploy/collector/schema.sql`), its
 * README and the report types of `@vaubaan/telemetry` describe the same thing.
 *
 * The SQL is read as text — no database here. What is pinned, for each of the
 * four tables (plugin health, decisions, instance profiles and their plugins):
 *
 *   - the table has the report columns, plus an identity and an arrival hour,
 *     and no column that could hold an address or a time the client chose;
 *   - `anon` may insert those columns and nothing else: no SELECT, UPDATE or
 *     DELETE privilege or policy;
 *   - the vocabularies and shapes of the CHECK constraints are the ones of
 *     `packages/telemetry/src/`;
 *   - the thresholds and limits published in the README are the ones of the SQL;
 *   - the README documents every field of every report.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ARCHES,
  COUNT_BUCKETS,
  DECISION_GATES,
  DECISION_OUTCOMES,
  DECISION_REPORT_KEYS,
  DEPLOYMENT_KINDS,
  DURATION_BUCKETS,
  ERROR_CLASSES_BY_OUTCOME,
  INSTANCE_ID_PATTERN,
  INSTANCE_PROFILE_KEYS,
  LEGACY_PROFILE_ID_KEY,
  MAX_PROFILE_PLUGINS,
  MAX_PROFILES_PER_BATCH,
  MAX_REPORTS_PER_BATCH,
  PLUGIN_REPORT_KEYS,
  PROFILE_PLUGIN_KEYS,
  QUEUE_DEFAULTS,
  REPORT_FIELD_PATTERNS,
  REPORT_OUTCOMES,
  RUNTIME_PATTERN,
  SIGN_IN_KINDS,
  UNSTAMPED_GATEWAY_VERSION,
} from '@vaubaan/telemetry';
import { describe, expect, it } from 'vitest';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const sql = readFileSync(resolve(REPO, 'deploy/collector/schema.sql'), 'utf8');
const readme = readFileSync(resolve(REPO, 'deploy/collector/README.md'), 'utf8');
/** The SQL without its comments: assertions are about statements, not prose. */
const statements = sql
  .split('\n')
  .map((lineText) => lineText.replace(/--.*$/, ''))
  .join('\n');

function quotedList(values: readonly string[]): string {
  return values.map((v) => `'${v}'`).join(', ');
}

/** Each table and the columns `anon` may insert, in the order of the report type. */
const TABLES: readonly (readonly [string, readonly string[]])[] = [
  ['plugin_reports', PLUGIN_REPORT_KEYS],
  ['decision_reports', DECISION_REPORT_KEYS],
  ['instance_profiles', INSTANCE_PROFILE_KEYS.filter((key) => key !== 'plugins')],
  ['instance_profile_plugins', ['instance_id', ...PROFILE_PLUGIN_KEYS]],
];

describe('structural: the collector schema matches the reports', () => {
  it.each(TABLES)(
    '%s stores the report columns, an identity and an hour — nothing else',
    (table, keys) => {
      const created = new RegExp(
        `create table if not exists public\\.${table} \\(([\\s\\S]*?)\\n\\);`,
      ).exec(statements);
      expect(created).not.toBeNull();
      const columns = (created?.[1] ?? '')
        .split('\n')
        .map((lineText) => lineText.trim().split(/\s+/)[0] ?? '')
        .filter((name) => name.length > 0);
      expect(columns).toEqual(['id', 'received_hour', ...keys]);
      expect(statements).toContain(`add constraint ${table}_received_hour_truncated`);
    },
  );

  it('never reads a request header, never stores an address', () => {
    expect(statements).not.toMatch(/\binet\b|request\.headers|current_setting\('request/);
    expect(statements).toMatch(
      /received_hour timestamptz not null default date_trunc\('hour', now\(\)\)/,
    );
  });

  it.each(TABLES)('lets anon insert the columns of %s and nothing else', (table, keys) => {
    expect(statements).toContain(`alter table public.${table} enable row level security;`);
    expect(statements).toContain(
      `revoke all on table public.${table} from public, anon, authenticated;`,
    );
    const grants = [
      ...statements.matchAll(
        new RegExp(`grant ([^;]+?)\\s+on table public\\.${table} to ([^;]+);`, 'g'),
      ),
    ];
    expect(grants).toHaveLength(1);
    expect(grants[0]?.[1]?.replace(/\s+/g, ' ').trim()).toBe(`insert (${keys.join(', ')})`);
    expect(grants[0]?.[2]?.trim()).toBe('anon');
    const policies = [
      ...statements.matchAll(
        new RegExp(`create policy (\\w+)\\s+on public\\.${table}\\s+for (\\w+)\\s+to (\\w+)`, 'g'),
      ),
    ];
    expect(policies.map((p) => [p[2], p[3]])).toEqual([['insert', 'anon']]);
    expect(statements).toContain(`create trigger ${table}_ingest_limit`);
  });

  it('publishes aggregates only: anon reads the views, which run with their owner rights', () => {
    for (const view of ['plugin_stats', 'plugin_instances', 'reporting_instances']) {
      expect(statements).toMatch(
        new RegExp(
          `create (or replace )?view public\\.${view}\\s+with \\(security_invoker = false\\)`,
        ),
      );
      expect(statements).toContain(`grant select on table public.${view} to anon, authenticated;`);
    }
    expect(statements).toMatch(
      /group by grouping sets \(\(r\.plugin, r\.plugin_version, r\.tool\), \(r\.plugin, r\.plugin_version\)\)/,
    );
    expect(statements).toContain(
      'revoke all on schema collector_private from public, anon, authenticated;',
    );
  });

  it('constrains plugin health to the vocabulary and the shapes of the report type', () => {
    expect(statements).toContain(`outcome in (${quotedList(REPORT_OUTCOMES)})`);
    for (const [outcome, classes] of Object.entries(ERROR_CLASSES_BY_OUTCOME)) {
      expect(statements, outcome).toContain(`outcome = '${outcome}'`);
      expect(statements, outcome).toContain(`error_class in (${quotedList(classes)})`);
    }
    expect(statements).toContain("(outcome = 'success' and error_class is null)");
    expect(statements).toContain(`duration_bucket in (${quotedList(DURATION_BUCKETS)})`);
    expect(statements).toContain(`plugin ~ '${REPORT_FIELD_PATTERNS.plugin.source}'`);
    expect(statements).toContain(`tool ~ '${REPORT_FIELD_PATTERNS.tool.source}'`);
    expect(statements).toContain(`plugin_version ~ '${REPORT_FIELD_PATTERNS.version.source}'`);
    expect(statements).toContain(`gateway_version ~ '${REPORT_FIELD_PATTERNS.version.source}'`);
    expect(statements).toContain(`gateway_version = '${UNSTAMPED_GATEWAY_VERSION}'`);
    expect(statements).toContain(`error_class ~ '${REPORT_FIELD_PATTERNS.httpErrorClass.source}'`);
  });

  it('constrains decisions and profiles to the vocabularies of usage.ts', () => {
    expect(statements).toContain(`decision in (${quotedList(DECISION_OUTCOMES)})`);
    expect(statements).toContain(`gate in (${quotedList(DECISION_GATES)})`);
    expect(statements).toContain('cardinality(risks) <= 32');
    expect(statements).toContain(`deployment in (${quotedList(DEPLOYMENT_KINDS)})`);
    expect(statements).toContain(`arch in (${quotedList(ARCHES)})`);
    expect(statements).toContain(`sign_in_kinds <@ array[${quotedList(SIGN_IN_KINDS)}]::text[]`);
    expect(statements).toContain(`runtime ~ '${RUNTIME_PATTERN.source}'`);
    for (const table of ['instance_profiles', 'instance_profile_plugins']) {
      expect(statements, table).toContain(
        `add constraint ${table}_instance_id_shape\n    check (instance_id ~ '${INSTANCE_ID_PATTERN.source}')`,
      );
    }
    for (const column of ['users', 'active_missions', 'calls', 'accounts']) {
      expect(statements, column).toContain(`${column} in (${quotedList(COUNT_BUCKETS)})`);
    }
  });

  it('excludes rejected credentials from the success rate, and never validates without a rate', () => {
    expect(statements).toContain(
      "(count(*) filter (where r.error_class = 'credential_rejected'))::bigint as credential_rejections",
    );
    expect(statements).toContain(
      'round(s.successes::numeric / nullif(s.reports - s.credential_rejections, 0), 4) as success_rate',
    );
    expect(statements).toMatch(/coalesce\(\s+s\.reports >= [\s\S]*?,\s+false\s+\) as validated/);
  });

  it('counts distinct instances per plugin version, per minor and per plugin over the window', () => {
    const view = /create view public\.plugin_instances[\s\S]*?;/.exec(statements)?.[0] ?? '';
    expect(view).toContain('count(distinct v.instance_id)::bigint as instances');
    expect(view).toContain(
      "split_part(p.plugin_version, '.', 1) || '.' || split_part(p.plugin_version, '.', 2) as plugin_minor",
    );
    expect(view).toContain('from public.instance_profile_plugins p');
    expect(view).toContain('select t.window_days from public.plugin_validation_thresholds() t');
    expect(view).toContain(
      'group by grouping sets ((v.plugin, v.plugin_version), (v.plugin, v.plugin_minor), (v.plugin))',
    );
  });

  it('renames the former daily identifier on a collector created before it, and nowhere else', () => {
    for (const table of ['instance_profiles', 'instance_profile_plugins']) {
      expect(statements, table).toContain(
        `alter table public.${table} rename column ${LEGACY_PROFILE_ID_KEY} to instance_id;`,
      );
    }
    const rest = statements.replace(/do \$\$[\s\S]*?rename column[\s\S]*?\$\$;/, '');
    expect(rest.replace(/drop constraint if exists \w+_day_id_shape/g, '')).not.toMatch(
      /\bday_id\b/,
    );
  });

  it('accepts a full batch of the client in one request', () => {
    const limits = /ingest_limits\(\)[\s\S]*?select (\d+), (\d+)/.exec(statements);
    const perStatement = Number(limits?.[1]);
    expect(perStatement).toBeGreaterThanOrEqual(QUEUE_DEFAULTS.batchSize);
    expect(perStatement).toBeGreaterThanOrEqual(MAX_REPORTS_PER_BATCH);
    // The plugins of the profiles of one batch go in one statement.
    expect(perStatement).toBeGreaterThanOrEqual(MAX_PROFILES_PER_BATCH * MAX_PROFILE_PLUGINS);
    expect(readme).toContain(`at most ${MAX_REPORTS_PER_BATCH}\nper request`);
    expect(readme).toContain(`more than ${limits?.[1]} reports in one request`);
  });

  it('publishes in the README the thresholds the SQL enforces', () => {
    const thresholds =
      /plugin_validation_thresholds\(\)[\s\S]*?select (\d+), (0\.\d+)::numeric, (\d+)/.exec(
        statements,
      );
    expect(thresholds).not.toBeNull();
    const [, minReports, minRate, windowDays] = thresholds ?? [];
    expect(readme).toMatch(new RegExp(`\\| Minimum reports\\s+\\| ${minReports}\\s+\\|`));
    expect(readme).toMatch(
      new RegExp(`\\| Minimum success rate \\| ${Math.round(Number(minRate) * 100)} %\\s+\\|`),
    );
    expect(readme).toContain(`over the last **${windowDays} days**`);
  });

  it('documents every field of every report and every closed value', () => {
    const keys = [
      ...PLUGIN_REPORT_KEYS,
      ...DECISION_REPORT_KEYS,
      ...INSTANCE_PROFILE_KEYS,
      ...PROFILE_PLUGIN_KEYS,
    ];
    for (const key of keys) expect(readme, key).toContain(`"${key}"`);
    for (const outcome of REPORT_OUTCOMES) expect(readme).toContain(`\`${outcome}\``);
    for (const errorClass of Object.values(ERROR_CLASSES_BY_OUTCOME).flat()) {
      expect(readme, errorClass).toContain(`\`${errorClass}\``);
    }
    for (const value of [...DURATION_BUCKETS, ...DECISION_GATES, ...COUNT_BUCKETS]) {
      expect(readme, value).toContain(`\`${value}\``);
    }
  });
});
