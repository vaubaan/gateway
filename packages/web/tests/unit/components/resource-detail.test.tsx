/**
 * Unit tests for the interactive parts of the Resource detail page
 * (`<ResourceDetailClient>` + `<AddAccessDialog>` — Phase 4 wave B).
 *
 * The server-component page itself is exercised end-to-end via the
 * `next build` static check (build OK) and the integration plan; here
 * we cover the client-side widgets only. `@crm/core/crypto` is mocked
 * (same approach as sealed.test.tsx) — round-trip correctness lives in
 * `packages/core/tests/unit/crypto/sealed-box.test.ts`.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';

import { type SealedBlobV1 } from '@crm/core/crypto';

import { ResourceDetailClient } from '@/components/resources/ResourceDetailClient';
import { __resetDefaultRecipientsCache } from '@/lib/sealed/use-default-recipients';

const cryptoState = vi.hoisted(() => ({
  lastSealedRecipients: null as ReadonlyArray<{ fp: string }> | null,
}));

vi.mock('@crm/core/crypto', () => ({
  sealForRecipients: (
    _plaintext: Uint8Array | string,
    recipients: ReadonlyArray<{ publicKey: Uint8Array; fingerprint: string }>,
  ): Promise<SealedBlobV1> => {
    cryptoState.lastSealedRecipients = recipients.map((r) => ({ fp: r.fingerprint }));
    return Promise.resolve({
      v: 1,
      recipients: recipients.map((r) => ({ fp: r.fingerprint, ct: 'AAAAAAAA' })),
    });
  },
  unsealAs: (): Promise<Uint8Array | null> => Promise.resolve(null),
  decodeUtf8: (b: Uint8Array): string => new TextDecoder().decode(b),
}));

function bytesToBase64(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]!);
  return btoa(s);
}

function fakePublicKey(): Uint8Array {
  const o = new Uint8Array(32);
  for (let i = 0; i < 32; i++) o[i] = i;
  return o;
}

function fakeFingerprint(prefix: string): string {
  return (prefix + 'a'.repeat(32)).slice(0, 32);
}

interface FetchCall {
  readonly url: string;
  readonly method: string;
  readonly body?: string;
}

interface FetchHandler {
  handler: (call: FetchCall) => Response | Promise<Response>;
  calls: FetchCall[];
}

function stringifyRequestInput(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  // RequestInfo with `.url` (a Request instance).
  return input.url;
}

function installFetchMock(handler: FetchHandler['handler']): FetchHandler {
  const calls: FetchCall[] = [];
  const fetchImpl: typeof fetch = (input, init) => {
    const url = stringifyRequestInput(input);
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? init.body : undefined;
    const call: FetchCall = { url, method, ...(body !== undefined ? { body } : {}) };
    calls.push(call);
    return Promise.resolve(handler(call));
  };
  global.fetch = vi.fn(fetchImpl);
  return { handler, calls };
}

async function flushAsync(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
}

describe('<ResourceDetailClient>', () => {
  beforeEach(() => {
    __resetDefaultRecipientsCache();
    cryptoState.lastSealedRecipients = null;
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders the Health button and surfaces "identity locked" when sk not in store', async () => {
    // No identityStore.set() before — the click should short-circuit to
    // 'identity locked' without ever firing a fetch.
    const mock = installFetchMock(() => new Response('{}', { status: 200 }));
    render(
      <ResourceDetailClient
        orgSlug="acme"
        resourceId="res-1"
        resourceName="r"
        kindId="github-org"
        accessKeys={['GITHUB_TOKEN']}
        destroyEnabled={false}
        providerRef={null}
        adminResourceId={null}
        providerMetadata={{}}
      />,
    );
    fireEvent.click(screen.getByTestId('resource-health-button'));
    await flushAsync();
    expect(mock.calls).toHaveLength(0);
    expect(screen.getByTestId('resource-health-state').textContent).toContain('identity locked');
  });

  it('opens the AddAccessDialog when an access-key button is clicked', () => {
    installFetchMock(() => new Response('{}'));
    render(
      <ResourceDetailClient
        orgSlug="acme"
        resourceId="res-1"
        resourceName="r"
        kindId="github-org"
        accessKeys={['GITHUB_TOKEN']}
        destroyEnabled={false}
        providerRef={null}
        adminResourceId={null}
        providerMetadata={{}}
      />,
    );
    expect(screen.queryByTestId('add-access-dialog')).toBeNull();
    fireEvent.click(screen.getByTestId('open-add-access-GITHUB_TOKEN'));
    expect(screen.getByTestId('add-access-dialog')).toBeTruthy();
  });

  it('AddAccessDialog seals the input and PUTs to /access/:key', async () => {
    // First call goes to /recipients; the second to /access PUT.
    const fp = fakeFingerprint('1');
    const mock = installFetchMock((call) => {
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
      return new Response(JSON.stringify({ ok: true, key: 'GITHUB_TOKEN', recipient_count: 1 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    // Override window.location.reload to keep the test environment alive.
    const reloadSpy = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { reload: reloadSpy, href: 'http://localhost/' },
    });

    render(
      <ResourceDetailClient
        orgSlug="acme"
        resourceId="res-1"
        resourceName="r"
        kindId="github-org"
        accessKeys={['GITHUB_TOKEN']}
        destroyEnabled={false}
        providerRef={null}
        adminResourceId={null}
        providerMetadata={{}}
      />,
    );
    fireEvent.click(screen.getByTestId('open-add-access-GITHUB_TOKEN'));
    await flushAsync();
    const ta = screen.getByTestId('sealed-input-textarea');
    fireEvent.change(ta, { target: { value: 'github_pat_xxx' } });
    await act(async () => {
      screen.getByTestId('sealed-input-seal').click();
      for (let i = 0; i < 12; i++) await Promise.resolve();
    });

    // 2 fetches: /recipients then PUT /access/GITHUB_TOKEN.
    expect(mock.calls.map((c) => c.url)).toEqual(
      expect.arrayContaining([
        '/api/crm/v1/resources/res-1/access/GITHUB_TOKEN/recipients',
        '/api/crm/v1/orgs/acme/resources/res-1/access/GITHUB_TOKEN',
      ]),
    );
    const putCall = mock.calls.find((c) => c.method === 'PUT');
    expect(putCall).toBeDefined();
    expect(putCall?.url).toContain('/access/GITHUB_TOKEN');
    const body = JSON.parse(putCall?.body ?? '{}') as {
      sealed_blob: { v: number; recipients: Array<{ fp: string; ct: string }> };
    };
    expect(body.sealed_blob.v).toBe(1);
    expect(body.sealed_blob.recipients[0]?.fp).toBe(fp);
    expect(reloadSpy).toHaveBeenCalled();
  });
});
