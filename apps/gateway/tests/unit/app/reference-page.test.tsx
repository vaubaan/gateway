/**
 * `/reference/<id>` is the service's page of the public site, exactly (spec §4.2,
 * ADR service-page-is-one-shared-package): the page is called as the plain async
 * function it is, over the real composition root (`:memory:` store) and its plugin
 * registry, and what it draws beside the frame is compared with the site's own
 * render of `/plugins/<id>` (`apps/website`'s `PluginPageView`) for the same
 * plugin: the same sections and headings, the same permission rows in the same
 * order. Then the instance's strip, the links under `docs.url`, and a plugin the
 * registry holds in another version (as a pinned one is) showing its own catalog.
 */
import { isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import githubPlugin from '@vaubaan/plugin-github';
import { createRegistry, type ServicePlugin } from '@vaubaan/plugin-sdk';
import supabasePlugin from '@vaubaan/plugin-supabase';

import { getRoot, resetRoot, type GatewayRoot } from '@/server/compose';
import { loadInstanceConfig } from '@/server/config';

import { PluginPageView } from '../../../../website/src/components/plugin/PluginPage';
import { unreadSnapshot } from '../../../../website/src/content/health';
import { withHealth } from '../../../../website/src/content/plugin-pages';
import { sitePluginInfo } from '../../../../website/src/content/plugins';
import { readRepoFile } from '../../../../website/src/content/repo';
import { parseThresholds, THRESHOLDS_SOURCE } from '../../../../website/src/content/thresholds';
import { memoryStoreDeps } from '../../support/compose/testing';
import { validEnv } from '../../support/config/testing';
import { appDir, renderPage } from './guard-harness';

const request = vi.hoisted(() => ({ headers: new Headers() }));
vi.mock('next/headers', () => ({ headers: async () => request.headers }));

const PAGE = `${appDir('(app)')}/reference/[id]/page.tsx`;
const DOCS_URL = 'https://docs.example.test/docs';

let root: GatewayRoot;

async function signedIn(plugins?: readonly ServicePlugin[]): Promise<void> {
  root = await getRoot({
    loadConfig: () =>
      loadInstanceConfig({
        env: validEnv({
          VAUBAAN_PUBLIC_URL: 'https://gateway.example.com',
          VAUBAAN_DOCS_URL: DOCS_URL,
        }),
      }),
    logWrite: () => undefined,
    ...memoryStoreDeps,
    ...(plugins ? { buildRegistry: async () => createRegistry(plugins) } : {}),
  });
  const user = await root.store.users.upsertFromIdp({
    issuer: 'http://idp.test',
    subject: 'ada',
    email: 'ada@example.com',
  });
  const session = await root.auth.sessions.create({
    kind: 'user',
    userId: user.id,
    login: { email: 'ada@example.com', groups: [] },
  });
  request.headers = new Headers({ cookie: session.setCookie.split(';')[0] ?? '' });
}

afterEach(async () => {
  await resetRoot();
});

/** What the page draws inside the Reference's frame (the frame's navigation needs a router). */
async function gatewayPage(id: string): Promise<string> {
  const outcome = await renderPage(PAGE, { id });
  if (outcome.kind !== 'returned' || !isValidElement<{ children: ReactNode }>(outcome.value)) {
    throw new Error(`/reference/${id} did not render: ${outcome.kind}`);
  }
  return renderToStaticMarkup(<>{outcome.value.props.children}</>);
}

/** `/plugins/<id>` as the site renders it, the collector unread. */
function sitePage(plugin: ServicePlugin): string {
  const [info] = withHealth(
    [sitePluginInfo(plugin, `plugins/${plugin.id}`, `@vaubaan/plugin-${plugin.id}`)],
    unreadSnapshot('offline in the tests'),
  );
  return renderToStaticMarkup(
    <PluginPageView plugin={info!} thresholds={parseThresholds(readRepoFile(THRESHOLDS_SOURCE))} />,
  );
}

/** Each section's id and heading, in order. */
function headings(html: string): string[] {
  return [
    ...html.matchAll(/<section id="([^"]+)"[^>]*>[\s\S]*?<h\d id="\1-title">(.*?)<\/h\d>/g),
  ].map((m) => `${m[1]}: ${m[2]}`);
}

/** Every permission row of the page, in order (the map's chips, Anything else, retired). */
function permissionRows(html: string): string[] {
  return [...html.matchAll(/data-risk-id="([^"]+)"/g)].map((m) => m[1]!);
}

const words = (html: string): string =>
  html
    .replace(/<wbr\/?>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ');

describe('/reference/<id> is the site’s page of the plugin', () => {
  for (const plugin of [githubPlugin, supabasePlugin] as const) {
    it(`${plugin.id}: the same sections, headings and permission rows as /plugins/${plugin.id}`, async () => {
      await signedIn();
      const gateway = await gatewayPage(plugin.id);
      const site = sitePage(plugin);
      const shared = headings(site).filter((h) => !/^(health|links):/.test(h));
      expect(shared.length).toBeGreaterThanOrEqual(7);
      expect(headings(gateway)).toEqual(shared);
      expect(permissionRows(gateway)).toEqual(permissionRows(site));
      expect(permissionRows(gateway).length).toBeGreaterThan(10);
      // The site's own parts stay on the site: no health, no links, no crumbs.
      expect(gateway).not.toContain('<section id="health"');
      expect(gateway).not.toContain('class="crumbs"');
      // Under the Reference's own title, the service's name is one level down.
      expect(gateway).not.toMatch(/<h1[ >]/);
      expect(gateway).toMatch(new RegExp(`<h2>${plugin.displayName} <span class="version">`));
    });
  }

  it('keeps the anchors the other pages link to, and sends the page’s links under docs.url', async () => {
    await signedIn();
    const github = await gatewayPage('github');
    expect(github).toContain('id="risk-github.read-code"');
    expect(github).toContain('id="macro-administer"');
    expect(github).toContain(`href="${DOCS_URL}/missions/git-remote"`);
    expect(github).not.toContain('href="/docs/');
  });

  it('says above the page what only this instance knows: the version it runs, its git remote', async () => {
    await signedIn();
    const github = await gatewayPage('github');
    const strip = github.slice(0, github.indexOf('class="plugin-page"'));
    expect(strip).toContain('data-testid="instance-strip"');
    expect(words(strip)).toContain(`This gateway runs plugin ${githubPlugin.version}`);
    expect(words(strip)).toContain('https://gateway.example.com/git/github/<owner>/<repo>.git');
    expect(strip).not.toContain('data-testid="plugin-pinned"');
    // A service without a git remote says nothing of one.
    const supabase = await gatewayPage('supabase');
    expect(supabase).not.toContain('data-testid="instance-git-remote"');
  });

  it('draws the plugin the instance runs: another version shows its own version and catalog', async () => {
    const older: ServicePlugin = {
      ...githubPlugin,
      version: '0.9.0',
      catalog: {
        ...githubPlugin.catalog,
        risks: githubPlugin.catalog.risks.map((risk) =>
          risk.id === 'github.read-code' ? { ...risk, label: 'Read code, as 0.9.0 said it' } : risk,
        ),
      },
    };
    await signedIn([older, supabasePlugin]);
    const page = await gatewayPage('github');
    expect(words(page)).toContain('This gateway runs plugin 0.9.0');
    expect(words(page)).toContain('GitHub 0.9.0');
    expect(words(page)).toContain('Read code, as 0.9.0 said it');
    expect(words(page)).not.toContain(`GitHub ${githubPlugin.version}`);
  });

  it('answers "not found" for a service the instance does not run', async () => {
    await signedIn();
    expect((await renderPage(PAGE, { id: 'no-such-service' })).kind).toBe('not-found');
  });
});
