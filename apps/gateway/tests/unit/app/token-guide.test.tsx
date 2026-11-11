/**
 * The token guide of the connect page (`TokenGuide`), rendered to static
 * markup from a `ConnectableProvider`: how wide to grant and why, the steps
 * with their page and command, the documentation, the expiry by who knows it.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { expiryWords, TokenGuide } from '@/components/connections/TokenGuide';
import type { ConnectableProvider, TokenGuideView } from '@/server/connections';

const GUIDE: TokenGuideView = {
  steps: [
    { do: 'Open the tokens page.', url: 'https://provider.example.com/tokens' },
    { do: 'Run the command.', code: 'acme tokens create --all' },
    { do: 'Copy the token and paste it here.' },
  ],
  reach: {
    what: 'Repository access',
    grant: 'All repositories',
    why: 'Each mission narrows what an agent may do.',
  },
  permissions: [
    { name: 'Contents', access: 'read-write', tools: [{ name: 'acme__push', title: 'Push' }] },
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
      steps: [{ do: 'Copy the Team ID.' }],
    },
    {
      id: 'project',
      label: 'One project',
      help: 'A token scoped to one project.',
      fields: ['project_id'],
      steps: [{ do: 'Copy the Project ID.' }],
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
    expect(html).toMatch(/<li>Open the tokens page\./);
  });
});
