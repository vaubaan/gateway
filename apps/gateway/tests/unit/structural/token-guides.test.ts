/**
 * Structural test (ADR one-place-to-authorize-services-token-first, amended
 * 2026-10-31): every plugin the image ships with a token way guides the
 * person completely — the token page, steps to act on, how wide to grant and
 * why, the permissions or what the token opens, who knows the expiry, the
 * service's documentation — and checks the token before anything is stored.
 *
 * Read from the plugins the image ships (`compose/shipped-plugins.ts`), not
 * from a list kept here. `definePlugin` refuses an incomplete guide; this
 * holds the shipped ones to the parts a definition cannot judge: a step is an
 * imperative sentence, the reach argues for the wide grant, the last step
 * ends at the paste, a secret field exists.
 */
import { describe, expect, it } from 'vitest';

import { SHIPPED_PLUGINS } from '../../../src/server/compose/shipped-plugins';

const TOKEN_PLUGINS = SHIPPED_PLUGINS.flatMap((plugin) =>
  plugin.credential.kind === 'api-key' ? [[plugin.id, plugin.credential] as const] : [],
);

/** A step starts with the verb of what to do, never with a note about the service. */
const IMPERATIVE =
  /^(?:Add|Check|Choose|Copy|Create|Generate|Grant|Leave|Name|Open|Paste|Reveal|Run|Share|Sign|Switch|Tick|Type|Use)\b/;

/** What the guides used to ask: the narrowest grant (ADR one-place-to-authorize-services-token-first, amended). */
const NARROW =
  /\bonly the [a-z ]+ (?:the )?(?:missions?|agents?) (?:need|may)|\bnothing else\b|\bpreferable\b|\bas needed\b/i;

describe('every shipped token way guides the person and checks the token', () => {
  it('the image ships token ways at all', () => {
    expect(TOKEN_PLUGINS.length).toBeGreaterThan(0);
  });

  describe.each(TOKEN_PLUGINS)('%s', (_id, spec) => {
    it('links the token page and names what the person creates', () => {
      expect(spec.createUrl).toMatch(/^https:\/\//);
      expect(spec.label).toMatch(/^\S/);
      expect(spec.guide.docsUrl).toMatch(/^https:\/\//);
    });

    it('lists steps to act on, the last one at the paste', () => {
      const alternativeSteps = (spec.alternatives ?? []).flatMap((alt) => alt.steps);
      for (const step of [...alternativeSteps, ...spec.guide.steps]) {
        expect(step.do).toMatch(IMPERATIVE);
      }
      expect(spec.guide.steps.at(-1)?.do).toMatch(/paste/i);
    });

    it('says how wide to grant and that the mission narrows it', () => {
      expect(spec.guide.reach.why).toMatch(/mission/);
      const words = [
        spec.guide.reach.grant,
        ...spec.guide.steps.map((step) => step.do),
        ...(spec.alternatives ?? []).flatMap((alt) => [
          alt.help ?? '',
          ...alt.steps.map((step) => step.do),
        ]),
        ...spec.fields.map((field) => field.help ?? ''),
      ];
      for (const text of words) expect(text).not.toMatch(NARROW);
    });

    it('says who knows the expiry', () => {
      expect(['provider-reports', 'person-types', 'none']).toContain(spec.guide.expiry.kind);
    });

    it('checks the token at paste and never shows it back', () => {
      expect(typeof spec.verify).toBe('function');
      expect(spec.fields.some((field) => field.secret)).toBe(true);
    });
  });
});
