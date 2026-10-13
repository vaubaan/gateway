/**
 * Structural test: the collector's schema (`deploy/collector/schema.sql`), its
 * README and the report type of `@vaubaan/telemetry` describe the same thing.
 *
 * The SQL is read as text — no database here. What is pinned:
 *
 *   - the table has the six report columns, plus an identity and a day, and
 *     no column that could hold an instance, an address or a time of day;
 *   - `anon` may insert those six columns and nothing else: no SELECT, UPDATE
 *     or DELETE privilege or policy on the table;
 *   - the outcomes, the error classes and the shapes of the CHECK constraints
 *     are the ones of `packages/telemetry/src/report.ts`;
 *   - the thresholds published in the README are the ones of the SQL function;
 *   - the single default collector URL of the code is the documented placeholder.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ERROR_CLASSES_BY_OUTCOME,
  PLUGIN_REPORT_KEYS,
  QUEUE_DEFAULTS,
  REPORT_FIELD_PATTERNS,
  REPORT_OUTCOMES,
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

describe('structural: the collector schema matches the report', () => {
  it('stores the six report columns, an identity and a day — nothing else', () => {
    const table = /create table if not exists public\.plugin_reports \(([\s\S]*?)\n\);/.exec(
      statements,
    );
    expect(table).not.toBeNull();
    const columns = (table?.[1] ?? '')
      .split('\n')
      .map((lineText) => lineText.trim().split(/\s+/)[0] ?? '')
      .filter((name) => name.length > 0);
    expect(columns).toEqual(['id', 'received_on', ...PLUGIN_REPORT_KEYS]);
    expect(statements).toMatch(/received_on date not null/);
    // No time of day, no address, no header ever reaches the database.
    expect(statements).not.toMatch(/timestamptz[^;]*plugin_reports|inet\b|request\.headers/);
  });

  it('lets anon insert the six columns and nothing else', () => {
    expect(statements).toContain('alter table public.plugin_reports enable row level security;');
    expect(statements).toContain(
      'revoke all on table public.plugin_reports from public, anon, authenticated;',
    );
    const grants = [
      ...statements.matchAll(/grant ([^;]+?) on table public\.plugin_reports to ([^;]+);/g),
    ];
    expect(grants).toHaveLength(1);
    expect(grants[0]?.[1]?.replace(/\s+/g, ' ').trim()).toBe(
      `insert (${PLUGIN_REPORT_KEYS.join(', ')})`,
    );
    expect(grants[0]?.[2]?.trim()).toBe('anon');

    const policies = [
      ...statements.matchAll(
        /create policy (\w+)\s+on public\.plugin_reports\s+for (\w+)\s+to (\w+)/g,
      ),
    ];
    expect(policies.map((p) => [p[2], p[3]])).toEqual([['insert', 'anon']]);
  });

  it('publishes aggregates only: anon reads the view, which runs with its owner rights', () => {
    expect(statements).toMatch(
      /create or replace view public\.plugin_stats\s+with \(security_invoker = false\)/,
    );
    expect(statements).toContain(
      'grant select on table public.plugin_stats to anon, authenticated;',
    );
    expect(statements).toMatch(
      /group by grouping sets \(\(r\.plugin, r\.plugin_version, r\.tool\), \(r\.plugin, r\.plugin_version\)\)/,
    );
  });

  it('constrains every column to the vocabulary and the shapes of the report type', () => {
    expect(statements).toContain(`outcome in (${quotedList(REPORT_OUTCOMES)})`);
    for (const [outcome, classes] of Object.entries(ERROR_CLASSES_BY_OUTCOME)) {
      expect(statements, outcome).toContain(`outcome = '${outcome}'`);
      expect(statements, outcome).toContain(`error_class in (${quotedList(classes)})`);
    }
    expect(statements).toContain("(outcome = 'success' and error_class is null)");
    expect(statements).toContain(`plugin ~ '${REPORT_FIELD_PATTERNS.plugin.source}'`);
    expect(statements).toContain(`tool ~ '${REPORT_FIELD_PATTERNS.tool.source}'`);
    expect(statements).toContain(`plugin_version ~ '${REPORT_FIELD_PATTERNS.version.source}'`);
    expect(statements).toContain(`gateway_version ~ '${REPORT_FIELD_PATTERNS.version.source}'`);
    expect(statements).toContain(`gateway_version = '${UNSTAMPED_GATEWAY_VERSION}'`);
    expect(statements).toContain(`error_class ~ '${REPORT_FIELD_PATTERNS.httpErrorClass.source}'`);
  });

  it('accepts a full batch of the client in one request', () => {
    const limits = /ingest_limits\(\)[\s\S]*?select (\d+), (\d+)/.exec(statements);
    expect(Number(limits?.[1])).toBeGreaterThanOrEqual(QUEUE_DEFAULTS.batchSize);
    expect(readme).toContain(`at most ${QUEUE_DEFAULTS.batchSize} per request`);
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

  it('documents every field of a report and every error class', () => {
    for (const key of PLUGIN_REPORT_KEYS) expect(readme).toContain(`"${key}"`);
    for (const outcome of REPORT_OUTCOMES) expect(readme).toContain(`\`${outcome}\``);
    for (const errorClass of Object.values(ERROR_CLASSES_BY_OUTCOME).flat()) {
      expect(readme, errorClass).toContain(`\`${errorClass}\``);
    }
  });
});
