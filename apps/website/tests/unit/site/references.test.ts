/**
 * The generated references (website spec §2.2): refusals, words and the
 * agents' reference are read from their sources, and a source that loses a
 * row fails the build instead of publishing a shorter page. The rows by trust
 * level are held to the policy engine in `sources-agree.test.ts`.
 */
import { describe, expect, it } from 'vitest';

import { AUTH_FAILURE_REASONS, isRefusal } from '@vaubaan/gateway-core';
import { REFUSAL_CODES } from '@vaubaan/shared';

import { escapeMdx, sectionsOf } from '../../../src/content/markdown';
import {
  AGENT_BOOTSTRAP,
  exampleRefusal,
  forAgentsMarkdown,
  GATEWAY_SPEC,
  parseBootstrapRefusals,
  parseVocabulary,
  PERSON_NEXT,
  referenceDocs,
  refusalFields,
  refusalsMarkdown,
  wordsMarkdown,
} from '../../../src/content/references';
import { readRepoFile } from '../../../src/content/repo';

const bootstrap = readRepoFile(AGENT_BOOTSTRAP);
const spec = readRepoFile(GATEWAY_SPEC);

/** GitHub's slugger, as the site's heading plugin applies it (`doc-links.test.ts` holds the same). */
function slugOf(heading: string): string {
  return heading
    .replace(/`([^`]*)`/g, '$1')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\p{Pc} -]/gu, '')
    .replace(/ /g, '-');
}

describe('the refusals reference', () => {
  const page = refusalsMarkdown(bootstrap);
  const headings = sectionsOf(page).map((s) => s.heading);

  it('has one section per refusal code of the gateway, its anchor the code itself', () => {
    for (const code of REFUSAL_CODES) {
      expect(headings).toContain(`\`${code}\``);
      expect(slugOf(`\`${code}\``)).toBe(code);
      expect(page).toContain(`[\`${code}\`](#${code})`);
    }
  });

  it('reads every code and every 401 reason from the agent bootstrap, which must name them all', () => {
    const { refusals, authFailures } = parseBootstrapRefusals(bootstrap);
    expect(refusals.map((r) => r.code).sort()).toEqual([...REFUSAL_CODES].sort());
    expect(authFailures.map((r) => r.code).sort()).toEqual([...AUTH_FAILURE_REASONS].sort());
    for (const row of [...refusals, ...authFailures]) {
      expect(row.happened, row.code).not.toBe('');
      expect(row.agentDoes, row.code).not.toBe('');
      expect(page).toContain(row.agentDoes);
    }
  });

  it('fails when the bootstrap forgets a code', () => {
    const without = bootstrap.replace(/^\| `wrong-credential-kind`.*$/m, '');
    expect(() => refusalsMarkdown(without)).toThrow(/missing: wrong-credential-kind/);
    expect(() => refusalsMarkdown('# Nothing\n')).toThrow(/When a call is refused/);
  });

  it('says, for each code, what the person does and the fields the gateway really sends', () => {
    for (const code of REFUSAL_CODES) {
      expect(PERSON_NEXT[code].length, code).toBeGreaterThan(40);
      expect(page).toContain(PERSON_NEXT[code]);
      const example = exampleRefusal(code);
      expect(example.code).toBe(code);
      for (const field of refusalFields(code)) expect(example).toHaveProperty(field);
    }
    // The builders write the hint; the example hints are the gateway's own words.
    expect(isRefusal(exampleRefusal('approval-required'))).toBe(true);
    expect(page).toContain('Hand this URL to the human steering you');
  });

  it('is listed among the generated pages, beside the other references', () => {
    const paths = referenceDocs().map((d) => d.path);
    expect(paths).toEqual([
      '/docs/reference/refusals',
      '/docs/reference/trust-levels',
      '/docs/reference/words',
      '/docs/reference/for-agents',
    ]);
  });
});

describe('the words reference', () => {
  it("is the gateway spec's vocabulary table, every pair of it", () => {
    const { same, pairs } = parseVocabulary(spec);
    expect(same).toEqual(['account', 'service', 'plugin']);
    expect(pairs.length).toBeGreaterThan(10);
    const page = wordsMarkdown(spec);
    for (const [ui, protocol] of pairs) expect(page).toContain(`| ${ui} | ${protocol} |`);
    expect(pairs).toContainEqual(['runs freely / ask me first', 'gate `auto` / `approval`']);
  });

  it('fails when the vocabulary changes shape', () => {
    expect(() => parseVocabulary('# Spec\n\n## 0. Vocabulary\n\nNo table.\n')).toThrow(/shape/);
    expect(() => parseVocabulary('# Spec\n')).toThrow(/Vocabulary/);
  });
});

describe('the reference for agents', () => {
  it('is the bootstrap every instance serves, whole, after a sentence saying so', () => {
    const page = forAgentsMarkdown(bootstrap);
    expect(page).toMatch(/^This page is the reference an agent/);
    expect(page).toContain('`/agent-bootstrap.md`');
    expect(page).not.toContain('# Vaubaan Agent Bootstrap');
    for (const section of sectionsOf(bootstrap)) expect(page).toContain(`## ${section.heading}`);
  });

  it('compiles as MDX once escaped: no brace or tag left in its prose', () => {
    const escaped = escapeMdx(forAgentsMarkdown(bootstrap));
    const prose = escaped
      .split(/^```[\s\S]*?^```/m)
      .join('')
      .replace(/`[^`]*`/g, '');
    expect(prose).not.toMatch(/(?<!\\)[{}]/);
    expect(prose).not.toMatch(/<[A-Za-z]/);
  });
});
