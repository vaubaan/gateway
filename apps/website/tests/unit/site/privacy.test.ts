/**
 * The privacy page (website spec §2.5 bis; intent believe-what-the-site-says,
 * "Read how Vaubaan handles my Google data"): what the broker keeps and never
 * keeps, Google's Limited Use sentence word for word, a link from every page.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { LIMITED_USE_SENTENCE, privacyMarkdown } from '../../../src/content/privacy';
import { twinRouteOf } from '../../../src/site/routing';

const SITE = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

describe('the privacy page', () => {
  const page = privacyMarkdown();

  it("says what Vaubaan's OAuth broker keeps, what it never keeps, and that calendar data goes only to the person's own instance", () => {
    expect(page).toContain('**What the broker keeps**');
    expect(page).toContain('**What the broker never keeps**');
    expect(page).toContain('go from Google to **your own instance** only');
    expect(page).toContain('`calendar.calendarlist.readonly`');
    expect(page).toContain('`calendar.events`');
  });

  it("carries Google's Limited Use sentence word for word", () => {
    expect(LIMITED_USE_SENTENCE).toBe(
      "Vaubaan's use and transfer of information received from Google APIs will adhere to the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including the Limited Use requirements.",
    );
    expect(page).toContain(LIMITED_USE_SENTENCE);
  });

  it('is linked from the footer of every page, with a Markdown twin', () => {
    // The footer of every page (src/components/Shell.tsx, SiteFooter).
    const shell = readFileSync(join(SITE, 'src/components/Shell.tsx'), 'utf8');
    const footer = shell.slice(shell.indexOf('export const FOOTER'));
    expect(footer).toContain("href: '/privacy'");
    expect(footer).toContain('export function SiteFooter');
    expect(twinRouteOf('/privacy.md')).toBe(twinRouteOf('/privacy'));
    expect(twinRouteOf('/privacy')).not.toBeNull();
  });
});
