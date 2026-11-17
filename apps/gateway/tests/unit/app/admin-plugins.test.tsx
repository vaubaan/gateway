/**
 * Administration › Plugins rendered to static markup over invented views (no browser,
 * no store): one row per plugin of the inventory with where it comes from, each kind
 * of feed notice only when the report holds one, and the line that says when and
 * where the feed was read — or that the check is off. What the comparison computes is
 * `server/updates/compare.test.ts`.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  PluginsPage,
  reportsSomething,
  type PluginLine,
  type PluginsView,
} from '@/app/admin/(guarded)/plugins/plugins-view';
import { PIN_A_PLUGIN_DOC } from '@/lib/project-docs';
import type { PluginInventoryEntry } from '@/server/plugins';
import type { UpdatesReport } from '@/server/updates';

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, '')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');

function line(entry: Partial<PluginInventoryEntry> & { id: string }, accounts = 0): PluginLine {
  return {
    entry: {
      name: entry.id,
      version: '1.0.0',
      origin: 'bundled',
      replaces: null,
      enabled: true,
      path: null,
      ...entry,
    },
    icon: null,
    accounts,
    validation: null,
  };
}

const LINES: readonly PluginLine[] = [
  line({ id: 'github', name: 'GitHub', version: '5.0.0' }, 3),
  line(
    {
      id: 'vercel',
      name: 'Vercel',
      version: '4.2.0',
      origin: 'pinned',
      replaces: '4.1.0',
      path: '/plugins/vercel',
    },
    1,
  ),
  line({
    id: 'acme',
    name: 'Acme',
    version: '0.1.0',
    origin: 'pinned',
    path: '/plugins/acme',
  }),
  line({ id: 'stripe', name: 'Stripe', enabled: false }),
];

const QUIET: UpdatesReport = {
  checkedAt: '2026-11-05T10:00:00.000Z',
  feedGeneratedAt: '2026-11-04T00:00:00.000Z',
  gateway: { current: '2.0.0', latest: '2.0.0', latestIsPrerelease: false, behind: false },
  pluginsBehind: [],
  advisories: [],
  olderPins: [],
};

function view(overrides: Partial<PluginsView> = {}): PluginsView {
  return {
    lines: LINES,
    check: true,
    feedUrl: 'https://vaubaan.example.com/versions.json',
    report: QUIET,
    failure: null,
    ...overrides,
  };
}

const render = (v: PluginsView) => renderToStaticMarkup(<PluginsPage view={v} />);

describe('Administration › Plugins', () => {
  it('lists every plugin with its id, version, origin, accounts, and a Reference link when registered', () => {
    const html = render(view());
    const page = text(html);
    expect(page).toContain('GitHub');
    expect(page).toContain('github · 5.0.0 · bundled with the image');
    expect(page).toContain('3 accounts');
    expect(page).toContain('pinned from /plugins/vercel, replaces bundled 4.1.0');
    expect(page).toContain('acme · 0.1.0 · pinned from /plugins/acme');
    expect(page).not.toContain('/plugins/acme, replaces');
    expect(page).toContain('disabled by plugins.enabled');
    expect(html).toContain('href="/reference/github"');
    expect(html).not.toContain('href="/reference/stripe"');
    // Nothing on the page installs anything; it says how a plugin changes, and links the guide.
    expect(html).toContain(PIN_A_PLUGIN_DOC);
    expect(page).toContain('A plugin installed here runs from the next start, on trial.');
  });

  it('shows no notice when the feed reports nothing, and says when and where it was read', () => {
    expect(reportsSomething(QUIET)).toBe(false);
    const html = render(view());
    expect(html).not.toContain('data-testid="updates-notices"');
    const footer = text(html);
    expect(footer).toContain('Versions feed read');
    expect(footer).toContain('from https://vaubaan.example.com/versions.json');
    expect(html).toContain('data-testid="updates-check-now"');
  });

  it('says the check is off, and offers no "Check now"', () => {
    const html = render(view({ check: false, report: null }));
    expect(text(html)).toContain('The versions check is off (updates.check)');
    expect(html).not.toContain('data-testid="updates-check-now"');
  });

  it('shows each kind the feed reports, an advisory in the one filled box', () => {
    const report: UpdatesReport = {
      ...QUIET,
      gateway: { current: '2.0.0', latest: '2.1.0-rc.1', latestIsPrerelease: true, behind: true },
      pluginsBehind: [{ id: 'github', loaded: '5.0.0', released: '5.1.0' }],
      advisories: [
        {
          id: 'VBN-2026-001',
          subject: { plugin: 'github' },
          loaded: '5.0.0',
          affected: '<5.0.1',
          fixed: '5.0.1',
          summary: 'A push to a protected branch was classified as an ordinary push.',
          url: 'https://vaubaan.example.com/advisories/VBN-2026-001',
          date: '2026-11-04',
        },
      ],
      olderPins: [{ id: 'vercel', pinned: '4.0.0', bundled: '4.1.0', path: '/plugins/vercel' }],
    };
    expect(reportsSomething(report)).toBe(true);
    const html = render(view({ report }));
    const page = text(html);
    expect(html).toContain('data-testid="updates-notices"');
    expect(page).toContain('2.0.0 → 2.1.0-rc.1');
    expect(page).toContain('pre-release');
    expect(page).toContain('GitHub: behind the released version');
    expect(page).toContain('5.0.0 → 5.1.0');
    expect(page).toContain('Vercel: pinned at an older version than the image bundles');
    expect(page).toContain('4.0.0 → 4.1.0');
    expect(html).toContain('href="https://vaubaan.example.com/advisories/VBN-2026-001"');
    expect(page).toContain('An advisory names a version this gateway runs');
    expect(page).toContain('fixed in 5.0.1');
    expect(html.match(/role="note"/g)).toHaveLength(1);
    expect(html).toContain('data-tone="bad"');
  });

  it('names the last failed read, and keeps the report it had', () => {
    const html = render(
      view({ failure: { at: '2026-11-05T11:00:00.000Z', failure: 'http-status', status: 503 } }),
    );
    const failure = text(html);
    expect(failure).toContain('The last read failed');
    expect(failure).toContain('the feed answered with an error status (HTTP 503)');
    expect(failure).toContain('what is shown is from the last read that succeeded');
  });
});
