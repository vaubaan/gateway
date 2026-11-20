/**
 * The docs section of the services moved from `/docs/providers` to `/docs/services` (ADR
 * one-word-per-thing-account-service-plugin, rename R2), and "Install with your coding agent"
 * under Install: every former address answers, permanently, at the page that took its place,
 * and the new place is a real page.
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  CODING_AGENT_INSTALL_PATH,
  SERVICES_DOCS_PATH,
  SITE_REDIRECTS,
} from '../../../src/site/redirects';

const CONTENT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../content');

describe('the former addresses of the services docs', () => {
  it.each([
    ['/docs/providers', '/docs/services'],
    ['/docs/providers.md', '/docs/services.md'],
    ['/docs/providers/:id([a-z][a-z0-9-]*)', '/plugins/:id#connect'],
    ['/docs/providers/:id([a-z][a-z0-9-]*).md', '/plugins/:id.md'],
  ])('%s answers at %s, permanently', (source, destination) => {
    expect(SITE_REDIRECTS).toContainEqual({ source, destination, permanent: true });
  });

  it('the section they lead to is a page of the docs', () => {
    expect(SERVICES_DOCS_PATH).toBe('/docs/services');
    expect(existsSync(resolve(CONTENT, 'docs/services/index.mdx'))).toBe(true);
    expect(existsSync(resolve(CONTENT, 'docs/providers'))).toBe(false);
  });

  it('install with your coding agent answers under Install, its twin too', () => {
    expect(CODING_AGENT_INSTALL_PATH).toBe('/docs/install/with-your-coding-agent');
    expect(SITE_REDIRECTS).toContainEqual({
      source: '/docs/install-with-your-coding-agent',
      destination: CODING_AGENT_INSTALL_PATH,
      permanent: true,
    });
    expect(SITE_REDIRECTS).toContainEqual({
      source: '/docs/install-with-your-coding-agent.md',
      destination: `${CODING_AGENT_INSTALL_PATH}.md`,
      permanent: true,
    });
    expect(existsSync(resolve(CONTENT, 'docs/install/with-your-coding-agent.mdx'))).toBe(true);
  });

  it('no redirect leaves from a page that exists', () => {
    for (const { source } of SITE_REDIRECTS) {
      const page = source.replace(/^\/docs\//, 'docs/').replace(/\.md$/, '');
      if (page.includes(':')) continue;
      expect(existsSync(resolve(CONTENT, `${page}.mdx`)), source).toBe(false);
      expect(existsSync(resolve(CONTENT, page, 'index.mdx')), source).toBe(false);
    }
  });
});
