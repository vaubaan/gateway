/**
 * Structural test (spec gateway-risk-model §4.6): every macro-action of every
 * catalog the image ships carries a `narrative` — two to four sentences in the
 * connector's words, at most 600 characters, shown on the plugin's public page
 * (ADR plugin-contract-and-credential-spec, amendment 2026-11-05).
 *
 * Read from the plugins the image ships (`compose/shipped-plugins.ts`), not
 * from a list kept here. The loader already refuses a narrative that is not a
 * string of at most 600 characters; this holds the shipped catalogs to
 * *having* one.
 */
import { describe, expect, it } from 'vitest';

import { REPOSITORY_PLUGINS } from '../../support/plugins/repository';

/** A sentence ends with one of these, then a space or the end of the text. */
const SENTENCE_END = /[.!?](?=\s|$)/g;

describe('every macro-action of a shipped catalog has a narrative', () => {
  describe.each(REPOSITORY_PLUGINS.map((plugin) => [plugin.id, plugin] as const))(
    '%s',
    (_id, plugin) => {
      const actions = plugin.catalog.macro_actions ?? [];

      it.each(actions.map((action) => [action.id, action] as const))('%s', (_action, action) => {
        expect(action.narrative).toEqual(expect.any(String));
        const narrative = action.narrative ?? '';
        expect(narrative.length).toBeLessThanOrEqual(600);
        const sentences = narrative.match(SENTENCE_END)?.length ?? 0;
        expect(sentences).toBeGreaterThanOrEqual(2);
        expect(sentences).toBeLessThanOrEqual(4);
      });
    },
  );
});
