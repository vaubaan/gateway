/**
 * The connect picker offers the catalog's plugins the instance does not have yet (ADR
 * plugins-installed-when-first-needed): each leads to its connection page, which installs
 * it; a service already installed is never offered twice.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ServicePicker } from '@/components/accounts/ServicePicker';
import type { ConnectableService } from '@/server/accounts';

import { InstallFirst } from '../../../src/app/(app)/accounts/new/[service]/install-first';

const github = {
  id: 'github',
  displayName: 'GitHub',
  kind: 'api-key',
  fields: [],
  unavailable: null,
  icon: null,
} as unknown as ConnectableService;

describe('the connect picker and the catalog', () => {
  it('offers the catalog’s plugins not installed here, after the installed ones', () => {
    const html = renderToStaticMarkup(
      <ServicePicker
        services={[github]}
        available={[
          { id: 'notion', released: '0.2.0', name: 'Notion' },
          { id: 'github', released: '5.3.1' },
        ]}
      />,
    );
    expect(html).toContain('data-testid="catalog-service-notion"');
    expect(html).toContain('href="/accounts/new/notion"');
    expect(html).not.toContain('catalog-service-github');
    expect(html.indexOf('service-github')).toBeLessThan(html.indexOf('catalog-service-notion'));
  });

  it('draws a catalog plugin with its own mark before it is installed, else its letter', () => {
    const html = renderToStaticMarkup(
      <ServicePicker
        services={[]}
        available={[
          {
            id: 'notion',
            released: '0.2.0',
            name: 'Notion',
            icon: { path: 'M1 2z', color: '#123456' },
          },
          { id: 'asana', released: '0.1.0', name: 'Asana', icon: null },
        ]}
      />,
    );
    expect(html).toContain('d="M1 2z"');
    expect(html).toContain('#123456');
    expect(html.match(/<path /g) ?? []).toHaveLength(1);
  });

  it('installs by a form that posts, and says why an installation failed', () => {
    const html = renderToStaticMarkup(
      <InstallFirst serviceId="notion" version="0.2.0" problem="did-not-load" detail="boom" />,
    );
    expect(html).toContain('method="post"');
    expect(html).toContain('action="/accounts/new/notion/install"');
    expect(html).toContain('data-testid="install-problem"');
    expect(html).toContain('boom');
  });
});
