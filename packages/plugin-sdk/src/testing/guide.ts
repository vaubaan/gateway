/**
 * The words of a token guide as one string, for a plugin test that checks
 * what its guide says: every step (sentence, page, command), then how wide
 * to grant and why.
 */
import type { TokenGuide } from '../credential.ts';

export function guideText(guide: TokenGuide): string {
  const steps = guide.steps.flatMap((step) => [step.do, step.url ?? '', step.code ?? '']);
  return [...steps, guide.reach.what, guide.reach.grant, guide.reach.why]
    .filter((part) => part !== '')
    .join(' ');
}
