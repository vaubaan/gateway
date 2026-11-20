/**
 * What the site reads from a file of the gateway is compared with the
 * gateway, here, since the site may not import it at build time (ADR
 * website-nextjs-on-vercel D1): the configuration keys, the published
 * thresholds; the explanation of permissions, whose examples name real
 * permissions in their real rows. The words of the risk model (the five facts and their values,
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
import { CARDINALITY_WORDS, ENVIRONMENT_RULES } from '@vaubaan/plugin-page/page-data';
import { factsOf, loadPlugins } from '../../../src/content/plugins';
import { readRepoFile, REPO_ROOT } from '../../../src/content/repo';
import { trustLevelsMarkdown } from '../../../src/content/references';
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
    // The page's own code is shared with the gateway's Reference (`@vaubaan/plugin-page`).
    const files = [
      'apps/website/src/content/plugins.ts',
      'apps/website/src/content/plugin-pages.ts',
      'apps/website/src/content/outputs.ts',
      'apps/website/src/content/references.ts',
      'apps/website/src/components/plugin/PluginPage.tsx',
      'packages/plugin-page/src/info.ts',
      'packages/plugin-page/src/examples.ts',
      'packages/plugin-page/src/page-data.ts',
      'packages/plugin-page/src/marks.tsx',
      'packages/plugin-page/src/ServicePage.tsx',
    ];
    for (const file of files) {
      const source = readRepoFile(file);
      for (const word of words) expect(source, `${file}: '${word}'`).not.toContain(`'${word}'`);
    }
  });
});

describe('the data model words of the plugin page', () => {
  // The gateway's service reference holds them in `apps/gateway`, which the site may not
  // import (ADR website-nextjs-on-vercel D1): the site restates them, and this compares.
  const reference = readRepoFile('apps/gateway/src/lib/services/reference.ts').replace(/\s+/g, ' ');

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

describe('the rows by trust level', () => {
  const page = trustLevelsMarkdown();
  const matrix = page.split('## The matrix')[1]?.split('\n## ')[0] ?? '';
  const rows = matrix.split('\n').filter((line) => /^\| \d\. /.test(line));

  it('print, for each row and trust level, the gate the policy engine gives', () => {
    expect(rows).toHaveLength(4);
    for (const line of rows) {
      const [label = '', ...cells] = line.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const row = Number(label[0]) as 1 | 2 | 3 | 4;
      expect(label).toBe(`${row}. ${policyEngine.ROW_WORDS[row]}`);
      policyEngine.TRUST_LEVELS.forEach((level, i) => {
        const gate = policyEngine.TRUST_LEVEL_GATES[level][row];
        const word =
          gate === null
            ? policyEngine.GATE_WORDS.off
            : policyEngine.GATE_WORDS[policyEngine.gateWordOf(gate)];
        expect(cells[i], `${level}, row ${row}`).toContain(word);
        if (gate !== null) expect(cells[i]).toContain(`\`${gate}\``);
      });
    }
  });

  it('carry the levels’ own words, their budget factors and every reason with its row', () => {
    for (const level of policyEngine.TRUST_LEVELS) {
      expect(page).toContain(
        `| ${policyEngine.TRUST_LEVEL_LABELS[level]} | ${policyEngine.TRUST_LEVEL_HINTS[level]} | ×${policyEngine.TRUST_LEVEL_BUDGET_FACTOR[level]} |`,
      );
    }
    for (const reason of policyEngine.REASONS) {
      const row = policyEngine.ROW_OF_REASON[reason];
      expect(page).toContain(
        `| ${policyEngine.REASON_WORDS[reason]} | ${row}. ${policyEngine.ROW_WORDS[row]} |`,
      );
    }
    expect(page).toContain(policyEngine.TREE_LEGEND);
  });
});

describe('the explanation of permissions', () => {
  const PAGE = 'apps/website/content/docs/concepts/permissions.mdx';
  const text = readRepoFile(PAGE);

  it('quotes each trust level as the interface says it', () => {
    for (const level of policyEngine.TRUST_LEVELS) {
      expect(text, level).toContain(
        `**${policyEngine.TRUST_LEVEL_LABELS[level]}**${level === 'careful' ? ' (the default)' : ''}: ${policyEngine.TRUST_LEVEL_HINTS[level]}`,
      );
    }
  });

  it('names real permissions, and puts each example in its real row', async () => {
    const plugins = await loadPlugins(REPO_ROOT);
    const rowOf = new Map(plugins.flatMap((p) => p.risks.map((r) => [r.id, r.row] as const)));
    const services = new Set(plugins.map((p) => p.id));
    // Every code span shaped like a permission id names one (the environment qualifier aside).
    const ids = [...text.matchAll(/`([a-z][a-z0-9-]*)(?:\[[a-z0-9-]+\])?(\.[a-z0-9.-]+)`/g)]
      .filter((m) => services.has(m[1] ?? ''))
      .map((m) => `${m[1]}${m[2]}`);
    expect(ids.length).toBeGreaterThan(20);
    for (const id of ids) expect(rowOf.has(id), id).toBe(true);
    // The table of examples: each permission sits in the row its line names.
    const lines = text.split('\n').filter((line) => /^\| [1-4]\. /.test(line));
    expect(lines).toHaveLength(4);
    for (const line of lines) {
      const row = Number(line.slice(2, 3));
      expect(line, `row ${row}`).toContain(policyEngine.ROW_WORDS[row as 1 | 2 | 3 | 4]);
      for (const match of line.matchAll(/`([a-z0-9.\-]+)`/g)) {
        expect(rowOf.get(match[1] ?? ''), match[1]).toBe(row);
      }
    }
  }, 60_000);
});
