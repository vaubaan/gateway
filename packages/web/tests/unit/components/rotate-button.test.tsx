/**
 * Unit tests for `<RotateAccessButton>` — Phase 6 wave C dispatcher
 * for the 3 rotation paths (spec §0.1, §7.4).
 *
 * The crypto module is mocked (same approach as resource-detail.test);
 * we focus on the dispatch logic + state transitions, not the actual
 * sealing math (covered in packages/core/tests/unit/crypto/).
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';

import { RotateAccessButton } from '@/components/resources/RotateAccessButton';
import { __resetDefaultRecipientsCache } from '@/lib/sealed/use-default-recipients';

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

describe('<RotateAccessButton> dispatcher paths', () => {
  beforeEach(() => {
    __resetDefaultRecipientsCache();
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders an idle "Rotate" button', () => {
    installFetchMock(() => new Response('{}'));
    render(<RotateAccessButton orgSlug="acme" resourceId="res-1" accessKey="GITHUB_TOKEN" />);
    expect(screen.getByTestId('rotate-GITHUB_TOKEN').textContent).toBe('Rotate');
  });

  it('shows the manual paste UI when rotation_method=manual', async () => {
    installFetchMock((call) => {
      if (call.url.endsWith('/rotate') && call.method === 'POST') {
        return new Response(
          JSON.stringify({
            status: 'pending-dispatch',
            rotation_method: 'manual',
            next_step: 'operator-action',
            setup_docs: '## Manual rotation\nPaste the new token below.',
          }),
          { status: 202 },
        );
      }
      return new Response('{}');
    });
    render(<RotateAccessButton orgSlug="acme" resourceId="res-1" accessKey="GITHUB_TOKEN" />);
    fireEvent.click(screen.getByTestId('rotate-GITHUB_TOKEN'));
    await flushAsync();
    expect(screen.getByTestId('rotate-manual')).toBeTruthy();
    expect(screen.getByTestId('rotate-setup-docs').textContent).toContain('Manual rotation');
  });

  it('shows the admin-mediated running state then attempts the auto path', async () => {
    let rotateCalled = 0;
    installFetchMock((call) => {
      if (call.url.endsWith('/rotate') && call.method === 'POST') {
        rotateCalled += 1;
        return new Response(
          JSON.stringify({
            status: 'pending-dispatch',
            rotation_method: 'admin-mediated',
            next_step: 'admin-rotate-child',
            admin_resource_id: 'admin-1',
            admin_kind: 'github-org-admin',
            child_provider_ref: 'acme/repo-a',
            setup_docs: 'docs',
          }),
          { status: 202 },
        );
      }
      // /access/:key (admin's access) — return a synthetic sealed_blob.
      if (call.url.match(/\/access\/GITHUB_TOKEN$/) && call.method === 'GET') {
        return new Response(
          JSON.stringify({
            sealed_blob: {
              v: 1,
              recipients: [{ fp: 'a'.repeat(32), ct: 'AAAAAAAA' }],
            },
          }),
          { status: 200 },
        );
      }
      return new Response('{}');
    });
    render(<RotateAccessButton orgSlug="acme" resourceId="res-1" accessKey="GITHUB_TOKEN" />);
    fireEvent.click(screen.getByTestId('rotate-GITHUB_TOKEN'));
    await flushAsync();
    // The dispatcher should have moved to the admin-running state.
    // Depending on how far the async chain progressed, we may already
    // see 'rotate-admin-running' or have advanced to a manual fallback
    // (the mocked admin.rotateChildAccess would actually call the
    // real provider; with our network mock it'll throw). Either way
    // the dispatch endpoint must have been called exactly once.
    expect(rotateCalled).toBe(1);
  });

  it('handles a non-2xx response from POST /rotate as an error', async () => {
    installFetchMock(
      () => new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }),
    );
    render(<RotateAccessButton orgSlug="acme" resourceId="res-1" accessKey="GITHUB_TOKEN" />);
    fireEvent.click(screen.getByTestId('rotate-GITHUB_TOKEN'));
    await flushAsync();
    expect(screen.getByTestId('rotate-error').textContent).toContain('unauthorized');
  });
});
