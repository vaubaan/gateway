/**
 * The Fly organization token's guide (`token.ts`) : the dashboard's Tokens
 * page, one visit, the command as an alternative to copy.
 */
import { describe, expect, test } from 'vitest';

import { FLY_TOKENS_PAGE, flyCredential } from '../../src/token.ts';

describe('fly token — the guide', () => {
  test('opens the Tokens page itself and asks for an organization token, no caveat to write', () => {
    expect(FLY_TOKENS_PAGE).toBe('https://fly.io/tokens');
    expect(flyCredential.createUrl).toBe(FLY_TOKENS_PAGE);
    const steps = flyCredential.guide.steps;
    expect(steps.some((step) => step.url === FLY_TOKENS_PAGE)).toBe(true);
    expect(steps.find((step) => step.code)?.code).toMatch(/^fly tokens create org --org <slug>/);
    expect(steps.map((step) => step.do).join(' ')).not.toMatch(/attenuate|caveats\.json/);
  });

  test('the expiry is typed by the person: Fly does not say it back at paste', () => {
    expect(flyCredential.guide.expiry).toEqual({ kind: 'person-types', recommendedDays: 90 });
  });
});
