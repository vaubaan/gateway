/**
 * What the site reads from a file of the gateway is compared with the
 * gateway, here, since the site may not import it at build time (ADR
 * website-nextjs-on-vercel D1): the configuration keys, the published
 * thresholds. The words of the risk model (the five facts and their values,
 * the gate words, Can / Asks first / Cannot), the row words and reasons,
 * the gates and the budgets are not copied: the site and the gateway import
 * them from `@vaubaan/policy-engine`, which this file holds.
 */
import { describe, expect, it } from 'vitest';

import * as policyEngine from '@vaubaan/policy-engine';
import { RISK_VECTOR_AXES } from '@vaubaan/shared';

import * as vocabulary from '../../../../gateway/src/lib/vocabulary';
import { KEYS } from '../../../../gateway/src/server/config/sources';
import {
  configKeysMarkdown,
  CONFIG_HANDBOOK,
  parseConfigKeys,
} from '../../../src/content/config-keys';
import { CARDINALITY_WORDS, ENVIRONMENT_RULES } from '../../../src/content/plugin-page';
import { factsOf, loadPlugins } from '../../../src/content/plugins';
import { readRepoFile, REPO_ROOT } from '../../../src/content/repo';
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

/** The risk model's words: one value, the policy engine's, behind both the gateway and the site. */
const RISK_WORDS = [
  'ALLOW_WORDS',
  'GATE_WORDS',
  'gateWordOf',
  'REASON_WORDS',
  'ROW_LABEL',
  'ROW_WORDS',
  'TREE_LEGEND',
  'TRUST_LEVEL_HINTS',
  'TRUST_LEVEL_LABELS',
  'WHY_LABELS',
  'WHY_ORDER',
  'WHY_VALUES',
  'whyValue',
] as const;

describe('the words of the risk model', () => {
  it('are the very values the gateway interface prints: re-exported, never copied', () => {
    for (const name of RISK_WORDS) expect(vocabulary[name], name).toBe(policyEngine[name]);
  });

  it('are what the site prints: every fact of every permission is the policy engine’s word', async () => {
    const plugins = await loadPlugins(REPO_ROOT);
    for (const risk of plugins.flatMap((p) => p.risks)) {
      expect(risk.facts, risk.id).toEqual(factsOf(risk.vector));
      expect(risk.undo, risk.id).toBe(
        policyEngine.WHY_VALUES.reversibility[risk.vector.reversibility],
      );
      for (const fact of risk.facts) {
        expect(fact.label).toBe(policyEngine.WHY_LABELS[fact.axis]);
        expect(fact.word).toBe(policyEngine.whyValue(fact.axis, fact.value));
      }
    }
  }, 60_000);

  it('are not restated in the site’s source: no word of the gateway is written there by hand', () => {
    const words = [
      ...Object.values(policyEngine.WHY_LABELS),
      ...Object.values(policyEngine.GATE_WORDS),
      ...Object.values(policyEngine.TRUST_LEVEL_HINTS),
      ...Object.values(policyEngine.WHY_VALUES).flatMap((values) => Object.values(values)),
      ...Object.values(policyEngine.ROW_WORDS),
      ...Object.values(policyEngine.REASON_WORDS),
      ...Object.values(policyEngine.ROW_GATE_SENTENCES),
      policyEngine.TREE_LEGEND,
    ]
      // A reason spelled like the catalog's own value (`irreversible`) is a protocol name too.
      .filter(
        (word) =>
          !Object.values(RISK_VECTOR_AXES).some((values) =>
            (values as readonly string[]).includes(word),
          ),
      )
      .filter((word) => word.length > 8);
    const files = [
      'content/plugins.ts',
      'content/plugin-examples.ts',
      'content/plugin-page.ts',
      'content/plugin-pages.ts',
      'content/outputs.ts',
      'components/plugin/Codes.tsx',
      'components/plugin/PluginPage.tsx',
    ];
    for (const file of files) {
      const source = readRepoFile(`apps/website/src/${file}`);
      for (const word of words) expect(source, `${file}: '${word}'`).not.toContain(`'${word}'`);
    }
  });
});

describe('the data model words of the plugin page', () => {
  // The gateway's provider reference holds them in `apps/gateway`, which the site may not
  // import (ADR website-nextjs-on-vercel D1): the site restates them, and this compares.
  const reference = readRepoFile('apps/gateway/src/lib/providers/reference.ts').replace(
    /\s+/g,
    ' ',
  );

  it('say each cardinality as the gateway reference says it', () => {
    for (const [cardinality, words] of Object.entries(CARDINALITY_WORDS)) {
      expect(reference, cardinality).toContain(`${cardinality}: '${words}'`);
    }
  });

  it('say the rule of the environment as the gateway reference says it', () => {
    for (const [source, rule] of Object.entries(ENVIRONMENT_RULES)) {
      expect(reference, source).toContain(rule);
    }
  });
});
