// The dependency audit gate: what counts as an advisory, what counts as a
// registry outage, and what the allowlist may say. No network: `npm audit` is
// never run here, only its recorded outputs are read.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_ALLOWLIST,
  GATED_SEVERITIES,
  RELEASE_WORKFLOW,
  decide,
  parseAllowlist,
  parseAuditOutput,
  publishes,
} from './audit-gate.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const via = (id, name, severity, extra = {}) => ({
  source: 1,
  name,
  dependency: name,
  title: `${name} does something bad`,
  url: `https://advisories.example.org/${id}`,
  severity,
  range: '<1.0.0',
  ...extra,
});

const REPORT = JSON.stringify({
  auditReportVersion: 2,
  vulnerabilities: {
    // A direct advisory, and a package that is only affected through another one.
    braces: {
      name: 'braces',
      severity: 'high',
      via: [via('GHSA-vfj7-8cjw-p6xm', 'braces', 'high')],
    },
    micromatch: { name: 'micromatch', severity: 'high', via: ['braces'] },
    tiny: { name: 'tiny', severity: 'low', via: [via('GHSA-2222-3333-4444', 'tiny', 'low')] },
  },
  metadata: {},
});

const entry = (id, pkg, overrides = {}) => ({
  id,
  package: pkg,
  reason: 'Reached only through a development tool that is absent from the image.',
  reviewed: '2026-10-13',
  review_by: '2027-01-13',
  ...overrides,
});

describe('publishes', () => {
  it('fails a registry outage closed on a tag and on the release workflow, open elsewhere', () => {
    expect(publishes({ GITHUB_REF_TYPE: 'tag', GITHUB_WORKFLOW: 'ci' })).toBe(true);
    expect(publishes({ GITHUB_REF_TYPE: 'branch', GITHUB_WORKFLOW: RELEASE_WORKFLOW })).toBe(true);
    expect(publishes({ GITHUB_REF_TYPE: 'branch', GITHUB_WORKFLOW: 'ci' })).toBe(false);
    expect(publishes({})).toBe(false);
  });

  it('knows the release workflow by the name release.yml gives itself', () => {
    const release = readFileSync(join(ROOT, '.github/workflows/release.yml'), 'utf8');
    expect(release).toMatch(new RegExp(`^name: ${RELEASE_WORKFLOW}$`, 'm'));
  });
});

describe('parseAuditOutput', () => {
  it('reads each advisory once, by its GHSA id, whatever number of packages it affects', () => {
    const outcome = parseAuditOutput(REPORT);
    if (outcome.kind !== 'report') throw new Error(`expected a report, got ${outcome.kind}`);
    expect(outcome.advisories.map((a) => [a.id, a.package, a.severity])).toEqual([
      ['GHSA-2222-3333-4444', 'tiny', 'low'],
      ['GHSA-vfj7-8cjw-p6xm', 'braces', 'high'],
    ]);
  });

  it('reads a clean report as no advisory', () => {
    expect(parseAuditOutput('{"auditReportVersion":2,"vulnerabilities":{},"metadata":{}}')).toEqual(
      { kind: 'report', advisories: [] },
    );
  });

  it.each([
    [
      'a DNS failure',
      '{"error":{"code":"ENOTFOUND","summary":"request to https://registry.example.org/-/npm/v1/security/advisories/bulk failed, reason: getaddrinfo ENOTFOUND registry.example.org"}}',
    ],
    ['a reset connection', '{"error":{"code":"ECONNRESET","summary":"socket hang up"}}'],
    [
      'a 503 of the audit endpoint',
      '{"error":{"code":"E503","summary":"503 Service Unavailable - POST https://registry.example.org/-/npm/v1/security/advisories/bulk"}}',
    ],
    ['a rate limit', '{"error":{"code":"E429","summary":"429 Too Many Requests"}}'],
    [
      'the audit endpoint erroring',
      '{"error":{"code":"ENOAUDIT","summary":"audit endpoint returned an error"}}',
    ],
    ['an HTML error page of a proxy', '<html><body>502 Bad Gateway</body></html>'],
  ])('tells %s from an advisory: registry-error, to retry', (_name, stdout) => {
    expect(parseAuditOutput(stdout).kind).toBe('registry-error');
  });

  it('does not take a broken tree or an unknown output for a registry outage', () => {
    expect(
      parseAuditOutput(
        '{"error":{"code":"ENOLOCK","summary":"This command requires an existing lockfile."}}',
      ).kind,
    ).toBe('unreadable');
    expect(parseAuditOutput('{"something":"else"}').kind).toBe('unreadable');
    // No output at all is `npm` missing, killed or crashed before it wrote anything: the
    // gate is broken, which is not "the registry did not answer".
    expect(parseAuditOutput('')).toEqual({
      kind: 'unreadable',
      detail: 'npm audit produced no output',
    });
    expect(parseAuditOutput('  \n').kind).toBe('unreadable');
    expect(parseAuditOutput('npm ERR! something unexpected').kind).toBe('unreadable');
  });
});

describe('decide', () => {
  const advisories = parseAuditOutput(REPORT).advisories;

  it('fails on a gated advisory the allowlist does not name; a low one is a notice', () => {
    const verdict = decide(advisories, [], '2026-10-13');
    expect(verdict.failures.map((f) => [f.advisory.id, f.why])).toEqual([
      ['GHSA-vfj7-8cjw-p6xm', 'not in the allowlist'],
    ]);
    expect(verdict.notices.map((a) => a.id)).toEqual(['GHSA-2222-3333-4444']);
    expect(GATED_SEVERITIES).toEqual(['moderate', 'high', 'critical']);
  });

  it('gates a severity it does not know: only `info` and `low` are notices', () => {
    const advisory = (severity) => ({
      id: 'GHSA-aaaa-bbbb-cccc',
      package: 'left-pad',
      severity,
      title: '',
      url: '',
      range: '',
    });
    for (const severity of ['unknown', '', 'severe', 'CRITICAL']) {
      expect(decide([advisory(severity)], [], '2026-10-13').failures, severity).toHaveLength(1);
    }
    for (const severity of ['info', 'low']) {
      const verdict = decide([advisory(severity)], [], '2026-10-13');
      expect(verdict.failures, severity).toEqual([]);
      expect(verdict.notices, severity).toHaveLength(1);
    }
  });

  it('keeps one advisory per package: the same id on a second package is not dropped', () => {
    const report = JSON.stringify({
      vulnerabilities: {
        a: {
          severity: 'high',
          via: [
            {
              name: 'a',
              severity: 'high',
              url: 'https://advisories.example.org/GHSA-vfj7-8cjw-p6xm',
            },
          ],
        },
        b: {
          severity: 'high',
          via: [
            {
              name: 'b',
              severity: 'high',
              url: 'https://advisories.example.org/GHSA-vfj7-8cjw-p6xm',
            },
          ],
        },
      },
    });
    const outcome = parseAuditOutput(report);
    expect(outcome.kind).toBe('report');
    expect(outcome.advisories.map(({ package: name }) => String(name))).toEqual(['a', 'b']);
    // Allowlisted for `a` only: `b` fails.
    const verdict = decide(outcome.advisories, [entry('GHSA-vfj7-8cjw-p6xm', 'a')], '2026-10-13');
    expect(verdict.failures.map((f) => f.advisory.package)).toEqual(['b']);
  });

  it('passes an allowlisted advisory until its review date, that day included', () => {
    const entries = [entry('GHSA-vfj7-8cjw-p6xm', 'braces')];
    for (const today of ['2026-10-13', '2027-01-13']) {
      const verdict = decide(advisories, entries, today);
      expect(verdict.failures, today).toEqual([]);
      expect(verdict.allowed.map((a) => a.advisory.id)).toEqual(['GHSA-vfj7-8cjw-p6xm']);
    }
  });

  it('fails once the review date has passed: an allowlist entry is a dated decision, not a mute', () => {
    const verdict = decide(advisories, [entry('GHSA-vfj7-8cjw-p6xm', 'braces')], '2027-01-14');
    expect(verdict.failures).toHaveLength(1);
    expect(verdict.failures[0].why).toContain('review lapsed on 2027-01-13');
  });

  it('does not let an id allowlisted for one package cover another package', () => {
    const verdict = decide(
      advisories,
      [entry('GHSA-vfj7-8cjw-p6xm', 'something-else')],
      '2026-10-13',
    );
    expect(verdict.failures).toHaveLength(1);
    expect(verdict.failures[0].why).toContain('"something-else"');
  });

  it('reports entries that matched nothing, without failing (an optional dependency may be absent)', () => {
    const verdict = decide([], [entry('GHSA-vfj7-8cjw-p6xm', 'braces')], '2026-10-13');
    expect(verdict.failures).toEqual([]);
    expect(verdict.unused.map((e) => e.id)).toEqual(['GHSA-vfj7-8cjw-p6xm']);
  });
});

describe('parseAllowlist', () => {
  const file = (advisories) => JSON.stringify({ advisories });

  it('accepts entries with an id, a package, a reason and the two dates', () => {
    expect(parseAllowlist(file([entry('GHSA-vfj7-8cjw-p6xm', 'braces')]))).toMatchObject({
      ok: true,
    });
    expect(parseAllowlist(file([]))).toEqual({ ok: true, entries: [] });
  });

  it.each([
    ['no reason', { reason: '' }, 'reason'],
    ['a reason too short to be one', { reason: 'not exploitable' }, 'reason'],
    ['no review date', { reviewed: undefined }, 'reviewed'],
    ['a review date that is not a date', { review_by: 'next quarter' }, 'review_by'],
    ['a review_by before the review', { review_by: '2026-10-01' }, 'review_by'],
    ['a wildcard instead of an id', { id: '*' }, 'id'],
    ['a CVE instead of a GHSA id', { id: 'CVE-2024-4068' }, 'id'],
    ['no package', { package: '' }, 'package'],
  ])('refuses an entry with %s', (_name, overrides, field) => {
    const parsed = parseAllowlist(file([entry('GHSA-vfj7-8cjw-p6xm', 'braces', overrides)]));
    expect(parsed.ok).toBe(false);
    expect(parsed.problems.join('\n')).toContain(`.${field}`);
  });

  it('refuses the same id twice, and a file that is not the expected shape', () => {
    const twice = [entry('GHSA-vfj7-8cjw-p6xm', 'braces'), entry('GHSA-vfj7-8cjw-p6xm', 'braces')];
    expect(parseAllowlist(file(twice)).problems?.join()).toContain('listed twice');
    expect(parseAllowlist('{').ok).toBe(false);
    expect(parseAllowlist('{"advisories":{}}').ok).toBe(false);
  });
});

describe('the allowlist this repository ships', () => {
  const shipped = parseAllowlist(readFileSync(join(ROOT, DEFAULT_ALLOWLIST), 'utf8'));

  it('is valid: every entry has a reason and a review date', () => {
    expect(shipped).toMatchObject({ ok: true });
  });

  it('gives no entry more than about a quarter before it is looked at again', () => {
    const QUARTER_AND_SLACK_DAYS = 100;
    for (const item of shipped.entries ?? []) {
      const days = (Date.parse(item.review_by) - Date.parse(item.reviewed)) / 86_400_000;
      expect(days, item.id).toBeLessThanOrEqual(QUARTER_AND_SLACK_DAYS);
    }
  });

  it('is what the CI job reads: `node scripts/audit-gate.mjs` in ci.yml', () => {
    const workflow = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');
    expect(workflow).toMatch(/^\s+audit:\n/m);
    expect(workflow).toContain('node scripts/audit-gate.mjs');
  });
});
