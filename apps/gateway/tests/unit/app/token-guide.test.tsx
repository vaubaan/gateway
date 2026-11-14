/**
 * The token guide of the connect page (`TokenGuide`), rendered to static
 * markup from a `ConnectableProvider`: how wide to grant and why, the steps
 * with their menu path, page, command and screenshot, the documentation, the
 * expiry by who knows it; the permissions by name and access, without the
 * tools they serve.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { expiryWords, permissionLines, TokenGuide } from '@/components/accounts/TokenGuide';
import type { ConnectableProvider, TokenGuideView } from '@/server/accounts';

const GUIDE: TokenGuideView = {
  steps: [
    {
      do: 'Open the tokens page.',
      url: 'https://provider.example.com/tokens',
      path: ['Settings', 'Developer settings', 'Tokens'],
      figure: null,
    },
    { do: 'Run the command.', code: 'acme tokens create --all', figure: null },
    {
      do: 'Tick the permissions below.',
      screenshot: 'token-form.webp',
      figure: {
        url: '/reference/acme/connect/token-form.webp',
        alt: 'The new token form',
        attribution: 'Acme docs, 2026-11 · from docs.acme.example (CC BY 4.0)',
      },
    },
    { do: 'Copy the token and paste it here.', figure: null },
  ],
  reach: {
    what: 'Repository access',
    grant: 'All repositories',
    why: 'Each mission narrows what an agent may do.',
  },
  permissions: [
    { name: 'Contents', access: 'read' },
    { name: 'Contents', access: 'read-write' },
    { name: 'Metadata', access: 'read' },
  ],
  expiry: { kind: 'provider-reports' },
  docsUrl: 'https://provider.example.com/docs/tokens',
};

function provider(
  guide: TokenGuideView,
  alternatives: ConnectableProvider['alternatives'] = [],
): ConnectableProvider {
  return {
    id: 'acme',
    displayName: 'Acme',
    description: null,
    icon: null,
    resource_noun: { one: 'resource', other: 'resources' },
    kind: 'api-key',
    redirects: false,
    viaBroker: false,
    brokerAttested: null,
    fields: [],
    alternatives,
    createUrl: 'https://provider.example.com/tokens',
    label: 'personal access token',
    guide,
    unavailable: null,
  };
}

describe('the token guide of the connect page', () => {
  const html = renderToStaticMarkup(
    <TokenGuide service="Acme" provider={provider(GUIDE)} formId="f" />,
  );

  it('says how wide to grant, and why, above the steps', () => {
    expect(html).toContain('Repository access: All repositories');
    expect(html.indexOf('Each mission narrows')).toBeLessThan(
      html.indexOf('Open the tokens page.'),
    );
  });

  it('puts the menu path before the sentence, as highlighted chips', () => {
    const segments = [...html.matchAll(/data-testid="guide-path-segment">([^<]*)</g)].map(
      (m) => m[1],
    );
    expect(segments).toEqual(['Settings', 'Developer settings', 'Tokens']);
    expect(html).toContain('aria-label="Where to click at Acme"');
    expect(html.indexOf('Developer settings')).toBeLessThan(html.indexOf('Open the tokens page.'));
    expect(html).toContain('›');
  });

  it('shows a screenshot under its step, with its provenance, and none elsewhere', () => {
    const figures = [...html.matchAll(/<figure[^>]*>(.*?)<\/figure>/g)].map((m) => m[1] ?? '');
    expect(figures).toHaveLength(1);
    expect(figures[0]).toMatch(
      /<img src="\/reference\/acme\/connect\/token-form\.webp" alt="The new token form" loading="lazy"\/>/,
    );
    expect(figures[0]).toContain(
      '<figcaption>Acme docs, 2026-11 · from docs.acme.example (CC BY 4.0)</figcaption>',
    );
    expect(html.indexOf('Tick the permissions below.')).toBeLessThan(html.indexOf('<figure'));
  });

  it('links a step to its page and shows its command as code to copy', () => {
    expect(html).toMatch(
      /Open the tokens page\. \(<a href="https:\/\/provider\.example\.com\/tokens"/,
    );
    expect(html).toMatch(
      /<pre[^>]*aria-label="Command to copy"[^>]*><code>acme tokens create --all<\/code>/,
    );
  });

  it('links the service documentation and asks to tick every permission', () => {
    expect(html).toContain('href="https://provider.example.com/docs/tokens"');
    expect(html).toContain('Tick all of them');
  });

  it('lists each permission once, by name and access, without the tools it serves', () => {
    expect(permissionLines(GUIDE.permissions)).toEqual([
      { name: 'Contents', write: true },
      { name: 'Metadata', write: false },
    ]);
    const permissions = html.slice(html.indexOf('data-testid="token-permissions"'));
    expect(permissions.match(/>Contents</g)).toHaveLength(1);
    expect(permissions).toContain('read and write');
    expect(permissions).toContain('>Metadata<');
    expect(permissions).not.toMatch(/\bfor [A-Z]/);
  });

  it('words the expiry by who knows it', () => {
    expect(expiryWords('Acme', { kind: 'provider-reports' })).toMatch(
      /tells this gateway the date/,
    );
    expect(expiryWords('Acme', { kind: 'person-types', recommendedDays: 90 })).toMatch(
      /about 90 days at Acme\. Acme does not tell this gateway the date/,
    );
    expect(expiryWords('Acme', { kind: 'none', reason: 'Delete it to end it.' })).toBe(
      'Delete it to end it.',
    );
  });
});

describe('the token guide of a key with alternatives', () => {
  const alternatives = [
    {
      id: 'team',
      label: 'Team',
      fields: ['team_id'],
      steps: [{ do: 'Copy the Team ID.', figure: null }],
    },
    {
      id: 'project',
      label: 'One project',
      help: 'A token scoped to one project.',
      fields: ['project_id'],
      steps: [{ do: 'Copy the Project ID.', figure: null }],
    },
  ];
  const html = renderToStaticMarkup(
    <TokenGuide
      service="Acme"
      provider={provider(GUIDE, alternatives)}
      chosen="project"
      formId="connect-form"
    />,
  );

  it('starts with a radio bound to the form, the chosen one checked', () => {
    const radios = [...html.matchAll(/<input[^>]*type="radio"[^>]*>/g)].map((m) => m[0]);
    expect(radios).toHaveLength(2);
    for (const radio of radios) {
      expect(radio).toContain('name="alternative"');
      expect(radio).toContain('form="connect-form"');
    }
    expect(radios[0]).toContain('value="team"');
    expect(radios[0]).not.toContain('checked');
    expect(radios[1]).toContain('value="project"');
    expect(radios[1]).toContain('checked=""');
    expect(html).toContain('A token scoped to one project.');
    expect(html.indexOf('type="radio"')).toBeLessThan(html.indexOf('Copy the Team ID.'));
  });

  it("puts each alternative's steps in its panel, before the shared steps", () => {
    expect(html).toMatch(/<li data-alternative-panel="0">Copy the Team ID\./);
    expect(html).toMatch(/<li data-alternative-panel="1">Copy the Project ID\./);
    expect(html.indexOf('Copy the Project ID.')).toBeLessThan(
      html.indexOf('Open the tokens page.'),
    );
    expect(html).toMatch(/<li><span class="path [^"]*"[^>]*>.*?<\/span>Open the tokens page\./);
  });
});
