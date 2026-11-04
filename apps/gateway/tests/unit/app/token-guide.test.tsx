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

function provider(guide: TokenGuideView): ConnectableProvider {
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
    createUrl: 'https://provider.example.com/tokens',
    label: 'personal access token',
    guide,
    unavailable: null,
  };
}

describe('the token guide of the connect page', () => {
  const html = renderToStaticMarkup(<TokenGuide service="Acme" provider={provider(GUIDE)} />);

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
