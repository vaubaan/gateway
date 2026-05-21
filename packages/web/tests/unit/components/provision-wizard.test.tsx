/**
 * Unit tests for `<ProvisionWizard>` — Phase 6 wave C 3-step wizard
 * (spec §7.3).
 *
 * We assert the step transitions only; the actual `admin.createChild`
 * calls are mocked via the catalog kind (real GitHub kind impl) and
 * the cross-network behaviour is covered by the catalog-level tests
 * (`github-admin.test.ts`).
 */

import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';

import { ProvisionWizard } from '@/components/wizard/ProvisionWizard';

vi.mock('@crm/core/crypto', () => ({
  sealForRecipients: () =>
    Promise.resolve({
      v: 1,
      recipients: [{ fp: 'a'.repeat(32), ct: 'AAAAAAAA' }],
    }),
  unsealAs: () => Promise.resolve(new TextEncoder().encode('admintoken')),
  decodeUtf8: (b: Uint8Array) => new TextDecoder().decode(b),
}));

vi.mock('@/lib/crypto/identity-store', () => ({
  identityStore: {
    get: () => ({
      fingerprint: 'a'.repeat(32),
      publicKey: new Uint8Array(32),
      privateKey: new Uint8Array(32),
    }),
  },
}));

interface FetchCall {
  readonly url: string;
  readonly method: string;
  readonly body?: string;
}

function installFetchMock(handler: (call: FetchCall) => Response | Promise<Response>): {
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  global.fetch = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? init.body : undefined;
    calls.push({ url, method, ...(body !== undefined ? { body } : {}) });
    return Promise.resolve(handler({ url, method, ...(body !== undefined ? { body } : {}) }));
  });
  return { calls };
}

async function flushAsync(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 16; i++) await Promise.resolve();
  });
}

describe('<ProvisionWizard> step machine', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders loading then transitions to pick-child step', async () => {
    installFetchMock((call) => {
      if (call.url.match(/\/resources\/admin-1$/)) {
        return new Response(
          JSON.stringify({
            resource: {
              id: 'admin-1',
              kind: 'github-org-admin',
              is_admin: true,
              provider_metadata: { org: 'acme' },
            },
          }),
          { status: 200 },
        );
      }
      return new Response('{}');
    });
    render(
      <ProvisionWizard
        orgSlug="acme"
        adminResourceId="admin-1"
        projectId="00000000-0000-0000-0000-000000000001"
      />,
    );
    expect(screen.getByTestId('provision-wizard-loading')).toBeTruthy();
    await flushAsync();
    expect(screen.getByTestId('provision-wizard-step-pick')).toBeTruthy();
    expect(screen.getByTestId('pick-child-github-repo')).toBeTruthy();
  });

  it('refuses a non-admin target', async () => {
    installFetchMock(
      () =>
        new Response(
          JSON.stringify({
            resource: {
              id: 'admin-1',
              kind: 'github-org',
              is_admin: false,
              provider_metadata: {},
            },
          }),
          { status: 200 },
        ),
    );
    render(
      <ProvisionWizard
        orgSlug="acme"
        adminResourceId="admin-1"
        projectId="00000000-0000-0000-0000-000000000001"
      />,
    );
    await flushAsync();
    expect(screen.getByTestId('provision-wizard-error').textContent).toContain(
      'not a live org-admin',
    );
  });

  it('moves to fill-spec when a child kind is picked', async () => {
    installFetchMock(
      () =>
        new Response(
          JSON.stringify({
            resource: {
              id: 'admin-1',
              kind: 'github-org-admin',
              is_admin: true,
              provider_metadata: { org: 'acme' },
            },
          }),
          { status: 200 },
        ),
    );
    render(
      <ProvisionWizard
        orgSlug="acme"
        adminResourceId="admin-1"
        projectId="00000000-0000-0000-0000-000000000001"
      />,
    );
    await flushAsync();
    fireEvent.click(screen.getByTestId('pick-child-github-repo'));
    expect(screen.getByTestId('provision-wizard-step-spec')).toBeTruthy();
    expect(screen.getByTestId('provision-spec-name')).toBeTruthy();
  });

  it('disables next when name is empty, enables when filled', async () => {
    installFetchMock(
      () =>
        new Response(
          JSON.stringify({
            resource: {
              id: 'admin-1',
              kind: 'github-org-admin',
              is_admin: true,
              provider_metadata: { org: 'acme' },
            },
          }),
          { status: 200 },
        ),
    );
    render(
      <ProvisionWizard
        orgSlug="acme"
        adminResourceId="admin-1"
        projectId="00000000-0000-0000-0000-000000000001"
      />,
    );
    await flushAsync();
    fireEvent.click(screen.getByTestId('pick-child-github-repo'));
    const next = screen.getByTestId('provision-spec-next');
    expect((next as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId('provision-spec-name'), { target: { value: 'repo-a' } });
    expect((next as HTMLButtonElement).disabled).toBe(false);
  });
});
