/**
 * Unit tests for the Register Resource wizard (Phase 4 wave C).
 *
 * Covers step transitions (Kind → Setup → Seal), the POST /resources
 * call on Setup submission, the PUT /access/:key call on Seal, and
 * the final redirect to the resource detail page.
 *
 * `@crm/core/crypto` is mocked at the boundary (same pattern as
 * sealed.test.tsx / resource-detail.test.tsx).
 */

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';

import { type SealedBlobV1 } from '@crm/core/crypto';

import { RegisterWizard } from '@/components/wizard/RegisterWizard';
import { __resetDefaultRecipientsCache } from '@/lib/sealed/use-default-recipients';
import { OnboardingForm } from '@/components/onboarding/OnboardingForm';
import type { SerializedKind } from '@/lib/catalog/serialize';

vi.mock('@crm/core/crypto', () => ({
  sealForRecipients: (
    _plaintext: Uint8Array | string,
    recipients: ReadonlyArray<{ publicKey: Uint8Array; fingerprint: string }>,
  ): Promise<SealedBlobV1> =>
    Promise.resolve({
      v: 1,
      recipients: recipients.map((r) => ({ fp: r.fingerprint, ct: 'AAAAAAAA' })),
    }),
  unsealAs: (): Promise<Uint8Array | null> => Promise.resolve(null),
  decodeUtf8: (b: Uint8Array): string => new TextDecoder().decode(b),
}));

function bytesToBase64(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]!);
  return btoa(s);
}

function fakeFingerprint(prefix: string): string {
  return (prefix + 'a'.repeat(32)).slice(0, 32);
}

function fakePublicKey(): Uint8Array {
  const o = new Uint8Array(32);
  for (let i = 0; i < 32; i++) o[i] = i;
  return o;
}

interface Call {
  readonly url: string;
  readonly method: string;
  readonly body?: string;
}

function installFetch(handler: (call: Call) => Response): Call[] {
  const calls: Call[] = [];
  const stringifyInput = (input: RequestInfo | URL): string => {
    if (typeof input === 'string') return input;
    if (input instanceof URL) return input.toString();
    return input.url;
  };
  const impl: typeof fetch = (input, init) => {
    const url = stringifyInput(input);
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? init.body : undefined;
    const call: Call = { url, method, ...(body !== undefined ? { body } : {}) };
    calls.push(call);
    return Promise.resolve(handler(call));
  };
  global.fetch = vi.fn(impl);
  return calls;
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}

const fp = fakeFingerprint('1');
function makeKindGithubOrg(): SerializedKind {
  return {
    id: 'github-org',
    provider: 'github',
    kindClass: 'org',
    displayName: 'GitHub Organization',
    setupDocs: '# GitHub Organization\n\nCreate a fine-grained PAT scoped to your org.',
    accessSchema: {
      GITHUB_TOKEN: { label: 'GitHub PAT', required: true, pattern: '^github_pat_' },
    },
    rotationMethod: 'manual',
    egressHosts: ['api.github.com', 'github.com'],
  };
}

describe('<RegisterWizard>', () => {
  beforeEach(() => {
    __resetDefaultRecipientsCache();
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('walks pick → setup → seal and finally redirects to detail page', async () => {
    const kind = makeKindGithubOrg();
    const reloadSpy = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { reload: reloadSpy, href: 'http://localhost/' },
    });

    const calls = installFetch((call) => {
      if (call.url.endsWith('/recipients')) {
        return new Response(
          JSON.stringify({
            defaults: [
              { user_id: 'u', public_key: bytesToBase64(fakePublicKey()), fingerprint: fp },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (call.method === 'POST' && call.url === '/api/crm/v1/orgs/acme/resources') {
        return new Response(JSON.stringify({ resource: { id: 'res-1' } }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (
        call.method === 'PUT' &&
        call.url === '/api/crm/v1/orgs/acme/resources/res-1/access/GITHUB_TOKEN'
      ) {
        return new Response(JSON.stringify({ ok: true, key: 'GITHUB_TOKEN', recipient_count: 1 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('not found', { status: 404 });
    });

    render(<RegisterWizard orgSlug="acme" kinds={[kind]} />);
    expect(screen.getByTestId('register-wizard').getAttribute('data-step')).toBe('pick');
    fireEvent.click(screen.getByTestId('wizard-kind-github-org'));
    expect(screen.getByTestId('register-wizard').getAttribute('data-step')).toBe('setup');

    fireEvent.change(screen.getByTestId('wizard-name'), { target: { value: 'acme-gh' } });
    fireEvent.change(screen.getByTestId('wizard-provider-ref'), { target: { value: 'acme' } });
    await act(async () => {
      screen.getByTestId('wizard-next').click();
      await flush();
    });
    expect(screen.getByTestId('register-wizard').getAttribute('data-step')).toBe('seal');

    // POST /resources call recorded.
    const postCall = calls.find(
      (c) => c.method === 'POST' && c.url === '/api/crm/v1/orgs/acme/resources',
    );
    expect(postCall).toBeDefined();
    const postBody = JSON.parse(postCall?.body ?? '{}') as { kind: string; name: string };
    expect(postBody.kind).toBe('github-org');
    expect(postBody.name).toBe('acme-gh');

    // Wait for the recipients fetch + render of SealedInput.
    await flush();
    const ta = screen.getByTestId('sealed-input-textarea');
    fireEvent.change(ta, { target: { value: 'github_pat_supersecret' } });
    await act(async () => {
      screen.getByTestId('sealed-input-seal').click();
      for (let i = 0; i < 15; i++) await Promise.resolve();
    });

    // PUT /access call recorded.
    const putCall = calls.find(
      (c) =>
        c.method === 'PUT' && c.url === '/api/crm/v1/orgs/acme/resources/res-1/access/GITHUB_TOKEN',
    );
    expect(putCall).toBeDefined();

    // After the seal succeeds, the status badge flips to "sealed".
    expect(screen.getByTestId('wizard-access-status-GITHUB_TOKEN').textContent).toBe('sealed');

    // Click finish → window.location.href is set to the detail page.
    screen.getByTestId('wizard-finish').click();
    expect(window.location.href).toContain('/orgs/acme/resources/res-1');
  });

  it('surfaces a POST /resources error and stays on setup', async () => {
    const kind = makeKindGithubOrg();
    installFetch((call) => {
      if (call.method === 'POST' && call.url.endsWith('/resources')) {
        return new Response(
          JSON.stringify({ error: 'unknown_kind', message: 'unknown kind: nope' }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('{}', { status: 200 });
    });

    render(<RegisterWizard orgSlug="acme" kinds={[kind]} />);
    fireEvent.click(screen.getByTestId('wizard-kind-github-org'));
    fireEvent.change(screen.getByTestId('wizard-name'), { target: { value: 'acme-gh' } });
    await act(async () => {
      screen.getByTestId('wizard-next').click();
      await flush();
    });
    expect(screen.getByTestId('register-wizard').getAttribute('data-step')).toBe('setup');
    expect(screen.getByTestId('wizard-submit-error').textContent).toContain('unknown kind');
  });
});

describe('<OnboardingForm>', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('POSTs to /api/crm/v1/orgs and redirects on success', async () => {
    const calls = installFetch(
      () =>
        new Response(JSON.stringify({ org: { id: 'org-1', slug: 'acme', name: 'Acme' } }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        }),
    );
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { href: 'http://localhost/' },
    });

    render(<OnboardingForm />);
    fireEvent.change(screen.getByTestId('onboarding-slug'), { target: { value: 'acme' } });
    fireEvent.change(screen.getByTestId('onboarding-name'), { target: { value: 'Acme Corp' } });
    await act(async () => {
      screen.getByTestId('onboarding-submit').click();
      await flush();
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('/api/crm/v1/orgs');
    expect(calls[0]?.method).toBe('POST');
    expect(window.location.href).toContain('/orgs/acme/resources');
  });

  it('refuses an invalid slug client-side without calling the API', async () => {
    const calls = installFetch(() => new Response('{}', { status: 200 }));
    render(<OnboardingForm />);
    fireEvent.change(screen.getByTestId('onboarding-slug'), { target: { value: 'ACME' } });
    fireEvent.change(screen.getByTestId('onboarding-name'), { target: { value: 'Acme' } });
    await act(async () => {
      screen.getByTestId('onboarding-submit').click();
      await flush();
    });
    expect(calls).toHaveLength(0);
    expect(screen.getByTestId('onboarding-error').textContent).toContain('slug must match');
  });
});
