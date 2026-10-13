import { describe, expect, it } from 'vitest';

import type { OAuthClientRecord } from '../store/types';
import { CONSENT_DECISION_PATH, MANAGEMENT_SCOPE } from './endpoints';
import {
  CONSENT_FIELD,
  consentPage,
  DECISION_FIELD,
  escapeHtml,
  messagePage,
  type ConsentView,
} from './pages';

const CLIENT: OAuthClientRecord = {
  id: 'client-row',
  clientId: 'vbn_client_abc',
  name: 'Claude Code',
  clientSecretHash: null,
  redirectUris: ['http://127.0.0.1/callback'],
  registration: 'dynamic',
  tokenEndpointAuthMethod: 'none',
  clientUri: null,
  metadataExpiresAt: null,
  operatorDecision: null,
  decidedAt: null,
  decidedBy: null,
  createdAt: '2026-10-13T09:00:00.000Z',
};

function view(overrides: Partial<ConsentView> = {}): ConsentView {
  return {
    consentId: 'consent-id-123',
    userEmail: 'ada@example.com',
    client: CLIENT,
    destination: { kind: 'loopback', label: '127.0.0.1:43210' },
    action: CONSENT_DECISION_PATH,
    ...overrides,
  };
}

describe('the consent screen', () => {
  it('names the client, the user, the single scope and where the code goes', async () => {
    const html = await consentPage(view()).text();
    expect(html).toContain('Claude Code');
    expect(html).toContain('ada@example.com');
    expect(html).toContain(`<code>${MANAGEMENT_SCOPE}</code>`);
    expect(html).toContain('vbn_client_abc');
    expect(html).toContain('127.0.0.1:43210');
  });

  it('says the name is a claim, and what the delegation can and can never do', async () => {
    const html = await consentPage(view()).text();
    expect(html).toContain('It is not verified');
    expect(html).toContain('issue missions in your name');
    expect(html).toContain('answer a request');
    expect(html).toContain('call a provider tool');
  });

  it('warns according to where the code goes', async () => {
    const loopback = await consentPage(view()).text();
    expect(loopback).toContain('running on this computer');
    const web = await consentPage(
      view({ destination: { kind: 'web', label: 'agent.example.net' } }),
    ).text();
    expect(web).toContain('A server on the network');
    expect(web).toContain('agent.example.net');
    const app = await consentPage(
      view({ destination: { kind: 'app-scheme', label: 'cursor://' } }),
    ).text();
    expect(app).toContain('cursor://');
    expect(app).toContain('your system opens');
  });

  it('posts the consent id and the answer, to the decision endpoint, Deny first', async () => {
    const html = await consentPage(view()).text();
    expect(html).toContain(`<form method="post" action="${CONSENT_DECISION_PATH}">`);
    expect(html).toContain(`name="${CONSENT_FIELD}" value="consent-id-123"`);
    const deny = html.indexOf(`name="${DECISION_FIELD}" value="deny"`);
    const approve = html.indexOf(`name="${DECISION_FIELD}" value="approve"`);
    // The first submit button is the one the Enter key activates.
    expect(deny).toBeGreaterThan(-1);
    expect(approve).toBeGreaterThan(deny);
    // Nothing of the authorization request travels through the browser.
    for (const absent of ['redirect_uri', 'code_challenge', 'state']) {
      expect(html).not.toContain(`name="${absent}"`);
    }
  });

  it('escapes everything the client said of itself', async () => {
    const hostile = view({
      client: {
        ...CLIENT,
        name: '<script>alert(1)</script><img src=x onerror=alert(2)>',
        clientId: '"><script>alert(3)</script>',
      },
      userEmail: 'ada"@example.com',
      destination: { kind: 'web', label: '<b>evil.example</b>' },
      consentId: '"><input name="decision" value="approve">',
    });
    const html = await consentPage(hostile).text();
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<b>evil.example</b>');
    expect(html).not.toContain('"><input name="decision"');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html.match(/<form /g)).toHaveLength(1);
    expect(html.match(/<button /g)).toHaveLength(2);
  });

  it('is never cached, never framed, sends no referrer off the instance and runs no script', async () => {
    const response = consentPage(view());
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    // Not `no-referrer`: the form of such a document would post `Origin: null`.
    expect(response.headers.get('referrer-policy')).toBe('same-origin');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    const csp = response.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('script-src');
    const html = await response.text();
    expect(html).not.toMatch(/<script|javascript:|\son[a-z]+=/i);
    const nonce = /style-src 'nonce-([^']+)'/.exec(csp)?.[1];
    expect(nonce).toBeTruthy();
    expect(html).toContain(`<style nonce="${nonce}">`);
  });

  it('uses a fresh style nonce for every response', () => {
    const csp = (): string | null => consentPage(view()).headers.get('content-security-policy');
    expect(csp()).not.toBe(csp());
  });
});

describe('message pages', () => {
  it('answer with the status, the title and the sentence, escaped, under the same headers', async () => {
    const response = messagePage(403, 'Waiting for an operator', 'Ask <an operator> & wait.');
    expect(response.status).toBe(403);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    const html = await response.text();
    expect(html).toContain('<h1>Waiting for an operator</h1>');
    expect(html).toContain('Ask &lt;an operator&gt; &amp; wait.');
  });
});

describe('the build footer', () => {
  const build = { version: '2.0.0-alpha.1', commit: 'abc1234' };

  it('is on the consent screen and on a message page, with the two stamps of /healthz', async () => {
    const consent = await consentPage(view({ build })).text();
    const message = await messagePage(400, 'Invalid request', 'No.', build).text();
    for (const html of [consent, message]) {
      expect(html).toContain('data-testid="build-footer"');
      expect(html).toContain('<span data-testid="gateway-version">2.0.0-alpha.1</span>');
      expect(html).toContain('<span data-testid="gateway-commit">abc1234</span>');
    }
  });

  it('escapes the stamps and adds nothing the content policy would have to allow', async () => {
    const response = consentPage(view({ build: { version: '<b>', commit: '"x"' } }));
    const html = await response.text();
    expect(html).toContain('&lt;b&gt;');
    expect(html).not.toContain('<b>');
    expect(html).not.toContain('<script');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
  });

  it('is absent when the handlers were given no build', async () => {
    expect(await consentPage(view()).text()).not.toContain('build-footer');
  });
});

describe('escapeHtml', () => {
  it('escapes the five characters that change the meaning of HTML', () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
      '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;',
    );
  });
});
