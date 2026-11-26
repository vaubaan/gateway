/**
 * Administration › Plugins and its Catalog page rendered to static markup over invented
 * views (no browser, no store): one row per plugin this gateway runs with where it comes
 * from and the acts it allows (Update, Roll back, Stop, each behind a dialog; Update all), what the
 * feed reports only when it reports it, the catalog's other plugins on their own page, and
 * the line that says when and where the feed was read — or that the check is off. What the
 * comparison computes is `server/updates/compare.test.ts`.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { CatalogPage } from '@/app/admin/(guarded)/plugins/catalog/catalog-view';
import type { InstallView } from '@/app/admin/(guarded)/plugins/install-view';
import {
  PluginsPage,
  type PluginLine,
  type PluginsView,
} from '@/app/admin/(guarded)/plugins/plugins-view';
import { PIN_A_PLUGIN_DOC } from '@/lib/project-docs';
import { PLUGIN_ACTIONS } from '@/server/plugins/handlers';
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
  line({ id: 'linear', name: 'Linear', version: '2.0.0', origin: 'installed' }, 2),
];

const QUIET: UpdatesReport = {
  checkedAt: '2026-11-05T10:00:00.000Z',
  feedGeneratedAt: '2026-11-04T00:00:00.000Z',
  gateway: { current: '2.0.0', latest: '2.0.0', latestIsPrerelease: false, behind: false },
  pluginsBehind: [],
  pluginsAvailable: [],
  catalogIds: [],
  catalog: {},
  catalogSource: 'feed',
  indexFailure: null,
  advisories: [],
  olderPins: [],
};

const INSTALL: InstallView = { canInstall: true, versions: [], activations: {}, flash: null };

function view(overrides: Partial<PluginsView> = {}): PluginsView {
  return {
    lines: LINES,
    check: true,
    feedUrl: 'https://vaubaan.example.com/versions.json',
    report: QUIET,
    failure: null,
    install: INSTALL,
    ...overrides,
  };
}

const render = (v: PluginsView) => renderToStaticMarkup(<PluginsPage view={v} />);

const BEHIND: UpdatesReport = {
  ...QUIET,
  pluginsBehind: [
    { id: 'github', loaded: '5.0.0', released: '5.1.0' },
    { id: 'linear', loaded: '2.0.0', released: '2.1.0' },
  ],
};

describe('Administration › Plugins', () => {
  it('lists only the plugins this gateway runs, with id, version, origin, accounts and a Reference link', () => {
    const html = render(view());
    const page = text(html);
    expect(page).toContain('GitHub');
    expect(page).toContain('github · 5.0.0 · bundled with the image · 3 accounts');
    expect(page).toContain('pinned from /plugins/vercel, replaces bundled 4.1.0');
    expect(page).toContain('acme · 0.1.0 · pinned from /plugins/acme');
    expect(page).not.toContain('/plugins/acme, replaces');
    expect(html).toContain('href="/reference/github"');
    // A plugin plugins.enabled leaves out has no row, only a quiet line naming it.
    expect(html).not.toContain('data-testid="plugin-stripe"');
    expect(page).toContain('1 more plugin is left out by plugins.enabled: stripe.');
    // Neither the upload nor the signers are here; the catalog page is one link away.
    expect(html).not.toContain(`action="${PLUGIN_ACTIONS.upload}"`);
    expect(html).not.toContain(`action="${PLUGIN_ACTIONS.addSigner}"`);
    expect(html).toContain('href="/admin/plugins/catalog"');
  });

  it('offers Update behind a dialog on a plugin behind the catalog, and Stop on one installed here', () => {
    const html = render(view({ report: BEHIND }));
    expect(html).toContain('data-testid="update-plugin-github"');
    expect(html).toContain('value="github@5.1.0"');
    expect(text(html)).toContain('Update to 5.1.0');
    expect(html).toContain(`action="${PLUGIN_ACTIONS.update}"`);
    // Nothing to type: the confirmation is a dialog, opened by a button that is not a submit.
    expect(html).not.toContain('name="confirm"');
    expect(html).toMatch(/<button[^>]*type="button"[^>]*data-testid="update-plugin-github"/);
    // Stop is on the row of a version installed here, never on a bundled one.
    expect(html).toContain('data-testid="stop-plugin-linear"');
    expect(html).not.toContain('data-testid="stop-plugin-github"');
    expect(html).toContain(`action="${PLUGIN_ACTIONS.followImage}"`);
  });

  it('offers Update all once two plugins or more are behind, and no Update where nothing installs', () => {
    const html = render(view({ report: BEHIND }));
    expect(html).toContain('data-testid="update-all"');
    expect(html).toContain('value="github@5.1.0,linear@2.1.0"');
    expect(text(html)).toContain('Update all (2)');
    const one = render(
      view({
        report: { ...QUIET, pluginsBehind: [{ id: 'github', loaded: '5.0.0', released: '5.1.0' }] },
      }),
    );
    expect(one).not.toContain('data-testid="update-all"');
    expect(one).toContain('data-testid="update-plugin-github"');
    const inMemory = render(view({ report: BEHIND, install: { ...INSTALL, canInstall: false } }));
    expect(inMemory).not.toContain('update-plugin-');
    expect(inMemory).not.toContain('data-testid="update-all"');
  });

  it('offers a Vaubaan version already downloaded as the row’s Update, not a second time below', () => {
    const pending = {
      digest: 'b'.repeat(64),
      pluginId: 'vercel',
      version: '4.2.4',
      packageName: '@vaubaan/plugin-vercel',
      sdkRange: '^1.0.0',
      trust: 'vaubaan' as const,
      signer: null,
      riskIds: [],
      state: 'pending' as const,
      failure: null,
      uploadedAt: '2026-11-22T14:09:00.000Z',
      uploadedBy: 'user-ops',
      viaMissionId: null,
      changedAt: '2026-11-22T14:09:00.000Z',
      changedBy: 'user-ops',
    };
    const html = render(view({ report: BEHIND, install: { ...INSTALL, versions: [pending] } }));
    expect(html).toContain('value="vercel@4.2.4"');
    expect(html).toContain('value="github@5.1.0,vercel@4.2.4,linear@2.1.0"');
    expect(text(html)).toContain('Update all (3)');
    expect(html).not.toContain('data-testid="install-versions"');
    // An upload not signed by Vaubaan still waits below, with its id to type.
    const unsigned = { ...pending, digest: 'c'.repeat(64), trust: 'unsigned' as const };
    const waiting = render(view({ install: { ...INSTALL, versions: [unsigned] } }));
    expect(waiting).toContain('data-testid="install-versions"');
    expect(waiting).not.toContain('value="vercel@4.2.4"');
  });

  it('offers Roll back on the row to the version it ran before, and no list of kept versions', () => {
    const kept = (
      digest: string,
      version: string,
      changedAt: string,
      sdkProblem: string | null,
    ) => {
      const record = {
        digest: digest.repeat(64),
        pluginId: 'linear',
        version,
        packageName: '@vaubaan/plugin-linear',
        sdkRange: '^1.0.0',
        trust: 'unsigned' as const,
        signer: null,
        riskIds: [],
        state: 'previous' as const,
        failure: null,
        uploadedAt: changedAt,
        uploadedBy: 'user-ops',
        viaMissionId: null,
        changedAt,
        changedBy: 'user-ops',
      };
      const activation = {
        version: record,
        running: { version: '2.0.0', origin: 'installed' },
        added: [],
        deprecated: [],
        unknownToIt: ['linear.issue-archive'],
        accounts: 2,
        missions: [],
        sdkProblem,
      };
      return [record, activation] as const;
    };
    // Newest change first: 1.9.0 is the one it ran last.
    const [last, lastView] = kept('d', '1.9.0', '2026-11-21T10:00:00.000Z', null);
    const [older, olderView] = kept('e', '1.8.0', '2026-11-20T10:00:00.000Z', null);
    const html = render(
      view({
        install: {
          ...INSTALL,
          versions: [last, older],
          activations: { [last.digest]: lastView, [older.digest]: olderView },
        },
      }),
    );
    expect(html).toContain('data-testid="rollback-plugin-linear"');
    expect(text(html)).toContain('Roll back to 1.9.0');
    expect(text(html)).not.toContain('Roll back to 1.8.0');
    expect(html).toContain(`value="${last.digest}"`);
    expect(html).toContain(`action="${PLUGIN_ACTIONS.activate}"`);
    // A dialog, nothing to type, even for a version not signed by Vaubaan: it already ran here.
    expect(html).not.toContain('name="confirm"');
    expect(html).toMatch(/<button[^>]*type="button"[^>]*data-testid="rollback-plugin-linear"/);
    expect(html).not.toContain('data-testid="kept-versions"');
    expect(html).not.toContain('data-testid="rollback-plugin-github"');
    // A kept version this gateway cannot run offers nothing.
    const [cannot, cannotView] = kept('f', '1.9.0', '2026-11-21T10:00:00.000Z', 'built for ^0.1.0');
    const greyed = render(
      view({
        install: { ...INSTALL, versions: [cannot], activations: { [cannot.digest]: cannotView } },
      }),
    );
    expect(greyed).not.toContain('data-testid="rollback-plugin-linear"');
  });

  it('offers no Update to the version a plugin already runs, nor to an older one', () => {
    // The feed was read before Linear went to 2.1.0; GitHub has an older download waiting.
    const updated = LINES.map((l) =>
      l.entry.id === 'linear' ? line({ ...l.entry, version: '2.1.0' }, l.accounts) : l,
    );
    const older = {
      digest: 'g'.repeat(64),
      pluginId: 'github',
      version: '4.9.0',
      packageName: '@vaubaan/plugin-github',
      sdkRange: '^1.0.0',
      trust: 'vaubaan' as const,
      signer: null,
      riskIds: [],
      state: 'pending' as const,
      failure: null,
      uploadedAt: '2026-11-22T14:09:00.000Z',
      uploadedBy: 'user-ops',
      viaMissionId: null,
      changedAt: '2026-11-22T14:09:00.000Z',
      changedBy: 'user-ops',
    };
    const html = render(
      view({
        lines: updated,
        report: { ...BEHIND, pluginsBehind: [BEHIND.pluginsBehind[1]!] },
        install: { ...INSTALL, versions: [older] },
      }),
    );
    expect(html).not.toContain('data-testid="update-plugin-linear"');
    expect(html).not.toContain('data-testid="update-plugin-github"');
  });

  it('says when and where the feed was read, and nothing more when it reports nothing', () => {
    const html = render(view());
    expect(html).not.toContain('data-testid="updates-advisories"');
    expect(html).not.toContain('data-testid="update-gateway"');
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

  it('shows an advisory in the one filled box, the gateway behind, and an older pin on its row', () => {
    const report: UpdatesReport = {
      ...QUIET,
      gateway: { current: '2.0.0', latest: '2.1.0-rc.1', latestIsPrerelease: true, behind: true },
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
    const html = render(view({ report }));
    const page = text(html);
    expect(page).toContain('2.0.0 → 2.1.0-rc.1');
    expect(page).toContain('pre-release');
    expect(html).toContain('data-testid="older-pin-vercel"');
    expect(page).toContain('pinned at an older version than the image bundles (4.1.0)');
    expect(html).toContain('href="https://vaubaan.example.com/advisories/VBN-2026-001"');
    expect(page).toContain('An advisory names a version this gateway runs');
    expect(page).toContain('fixed in 5.0.1');
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

describe('Administration › Plugins › Catalog', () => {
  const offer = [
    { id: 'notion', released: '1.0.0', name: 'Notion' },
    { id: 'asana', released: '3.2.0', name: 'Asana' },
  ];

  it('lists the catalog plugins this gateway does not run, each installed in one click', () => {
    const html = renderToStaticMarkup(<CatalogPage view={{ offer, install: INSTALL }} />);
    const page = text(html);
    expect(page.indexOf('Asana')).toBeLessThan(page.indexOf('Notion'));
    expect(html).toContain('data-testid="install-catalog-notion"');
    expect(html).toContain('value="notion@1.0.0"');
    expect(html).toContain(`action="${PLUGIN_ACTIONS.update}"`);
    // The catalog page holds the upload and the signers, and the guide to pinning.
    expect(html).toContain(`action="${PLUGIN_ACTIONS.upload}"`);
    expect(html).toContain(PIN_A_PLUGIN_DOC);
    const inMemory = renderToStaticMarkup(
      <CatalogPage view={{ offer, install: { ...INSTALL, canInstall: false } }} />,
    );
    expect(inMemory).toContain('data-testid="available-plugin-notion"');
    expect(inMemory).not.toContain('install-catalog-');
  });

  it('draws each catalog plugin with the mark its index gives, before it is installed', () => {
    const html = renderToStaticMarkup(
      <CatalogPage
        view={{
          offer: [
            {
              id: 'notion',
              released: '1.0.0',
              name: 'Notion',
              icon: { path: 'M3 4z', color: '#654321' },
            },
          ],
          install: INSTALL,
        }}
      />,
    );
    expect(html).toContain('d="M3 4z"');
    expect(html).toContain('#654321');
  });

  it('says when the gateway already runs the whole catalog', () => {
    const html = renderToStaticMarkup(<CatalogPage view={{ offer: [], install: INSTALL }} />);
    expect(text(html)).toContain('This gateway already runs every plugin of the catalog it read.');
  });
});
