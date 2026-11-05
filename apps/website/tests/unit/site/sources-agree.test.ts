/**
 * What the site copies from the gateway is compared with the gateway, here,
 * since the site may not import it at build time (ADR website-nextjs-on-vercel
 * D1): the configuration keys, the published thresholds. The severity word is
 * not copied: the site imports it from `@vaubaan/policy-engine`.
 */
import { describe, expect, it } from 'vitest';

import { KEYS } from '../../../../gateway/src/server/config/sources';
import {
  configKeysMarkdown,
  CONFIG_HANDBOOK,
  parseConfigKeys,
} from '../../../src/content/config-keys';
import { readRepoFile } from '../../../src/content/repo';
import { parseThresholds, THRESHOLDS_SOURCE } from '../../../src/content/thresholds';

const FAMILIES = ['sign_in.<id>.<field>', 'oauth_brokers.<name>.<field>'];

describe('the configuration keys page', () => {
  const rows = parseConfigKeys(readRepoFile(CONFIG_HANDBOOK));

  it('has one row per key of the gateway loader (KEYS), plus the named key families', () => {
    expect(rows.map((r) => r.key).sort()).toEqual([...KEYS.map((k) => k.path), ...FAMILIES].sort());
  });

  it('names, for each key, the environment variable the loader reads', () => {
    for (const spec of KEYS) {
      const row = rows.find((r) => r.key === spec.path);
      expect(row?.env, spec.path).toContain(spec.env);
    }
  });

  it('prints every key in the generated table', () => {
    const table = configKeysMarkdown(rows);
    for (const spec of KEYS) expect(table).toContain(`\`${spec.path}\``);
  });
});

describe('the published validation thresholds', () => {
  const thresholds = parseThresholds(readRepoFile(THRESHOLDS_SOURCE));

  it('are the collector’s: 200 reports, 90 % success, 90 days', () => {
    expect(thresholds).toEqual({ minReports: 200, minSuccessRate: 0.9, windowDays: 90 });
  });

  it('match the collector README the instances’ operators read', () => {
    const readme = readRepoFile('deploy/collector/README.md');
    expect(readme).toMatch(
      new RegExp(`\\| Minimum reports\\s+\\| ${thresholds.minReports}\\s+\\|`),
    );
    expect(readme).toMatch(
      new RegExp(`\\| Minimum success rate \\| ${Math.round(thresholds.minSuccessRate * 100)} %`),
    );
    expect(readme).toContain(`over the last **${thresholds.windowDays} days**`);
  });
});
