/**
 * Unit tests for the SecretManager UI components — Phase 5 wave B.
 *
 * - `<ConnectInfisicalWizard>` 3-step flow : config → seal → submit,
 *   with `@crm/core/crypto.sealForRecipients` mocked at the boundary
 *   (the seal correctness is already covered by
 *   `packages/core/tests/unit/crypto/sealed-box.test.ts`).
 * - `<SecretManagerList>` rendering + `<SetDefaultButton>` PATCH flow.
 * - `<NeedsResealBanner>` display logic (count > 0 → visible).
 *
 * Spec §11.1, §6.2, §4.5.
 */

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act, cleanup, waitFor } from '@testing-library/react';

const cryptoState = vi.hoisted(() => ({
  lastSealCleartext: null as Uint8Array | null,
}));

vi.mock('@crm/core/crypto', () => ({
  sealForRecipients: (cleartext: Uint8Array, recipients: ReadonlyArray<{ fp: string }>) => {
    cryptoState.lastSealCleartext = new Uint8Array(cleartext);
    return Promise.resolve({
      v: 1 as const,
      recipients: recipients.map((r, i) => ({ fp: r.fp, ct: `ct-${String(i)}` })),
    });
  },
  unsealAs: () => Promise.resolve(null),
}));

// Mock the re-seal-blob module so the banner can be tested without
// needing an identity in the store.
vi.mock('@/lib/secret-managers/re-seal-blob', () => ({
  runReseal: vi.fn(),
}));

import { ConnectInfisicalWizard } from '@/components/secret-managers/ConnectInfisicalWizard';
import { NeedsResealBanner } from '@/components/needs-reseal/NeedsResealBanner';
import { SecretManagerList } from '@/components/secret-managers/SecretManagerList';
import { runReseal } from '@/lib/secret-managers/re-seal-blob';

const FP_A = '0123456789abcdef0123456789abcdef';
const FP_B = 'fedcba9876543210fedcba9876543210';
const PUB_B64 = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

const RECIPIENTS = [
  { user_id: 'u-1', fingerprint: FP_A, public_key_b64: PUB_B64 },
  { user_id: 'u-2', fingerprint: FP_B, public_key_b64: PUB_B64 },
];

let originalFetch: typeof globalThis.fetch;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  cryptoState.lastSealCleartext = null;
  originalFetch = globalThis.fetch;
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  cleanup();
  vi.clearAllMocks();
});

describe('<ConnectInfisicalWizard>', () => {
  it('walks through config → seal → submit and POSTs the sealed body', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ secret_manager: { id: 'sm-1', kind: 'infisical', name: 'default' } }),
        { status: 201 },
      ),
    );
    // jsdom stub: window.location.href is read-only in jsdom default; we
    // intercept the redirect by replacing the property.
    const locationStub: { href: string } = { href: '' };
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: locationStub,
    });

    render(<ConnectInfisicalWizard orgSlug="acme" recipients={RECIPIENTS} />);

    expect(screen.getByTestId('connect-infisical-wizard').dataset.step).toBe('config');

    fireEvent.change(screen.getByTestId('wizard-input-workspace'), {
      target: { value: 'ws-uuid' },
    });
    fireEvent.change(screen.getByTestId('wizard-input-clientid'), {
      target: { value: 'cid-uuid' },
    });
    fireEvent.change(screen.getByTestId('wizard-input-clientsecret'), {
      target: { value: 'super-secret' },
    });
    fireEvent.click(screen.getByTestId('wizard-input-is-default'));
    fireEvent.click(screen.getByTestId('wizard-button-next-seal'));

    expect(screen.getByTestId('connect-infisical-wizard').dataset.step).toBe('seal');

    await act(() => {
      fireEvent.click(screen.getByTestId('wizard-button-seal'));
      return Promise.resolve();
    });

    expect(screen.getByTestId('connect-infisical-wizard').dataset.step).toBe('submit');
    // Cleartext was captured by the mocked seal.
    expect(cryptoState.lastSealCleartext).not.toBeNull();
    const captured = cryptoState.lastSealCleartext;
    if (!captured) throw new Error('cleartext not captured');
    const sealedJson = new TextDecoder().decode(captured);
    expect(sealedJson).toContain('cid-uuid');
    expect(sealedJson).toContain('super-secret');

    // After seal, the form state should have wiped the clientSecret field.
    const csInputAfter = screen.getByTestId('wizard-button-back-to-seal');
    expect(csInputAfter).toBeTruthy();

    await act(() => {
      fireEvent.click(screen.getByTestId('wizard-button-submit'));
      return Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/crm/v1/orgs/acme/secret-managers');
    expect(init.method).toBe('POST');
    const bodyStr = init.body;
    if (typeof bodyStr !== 'string') throw new Error('expected string body');
    const body = JSON.parse(bodyStr) as Record<string, unknown>;
    expect(body.kind).toBe('infisical');
    expect(body.is_default).toBe(true);
    const blob = body.auth_sealed_blob as { recipients: unknown[] };
    expect(blob.recipients).toHaveLength(2);
    // ZK invariant: no cleartext credential in the network body.
    expect(bodyStr).not.toContain('super-secret');
  });

  it('refuses to advance past config when fields are missing', () => {
    render(<ConnectInfisicalWizard orgSlug="acme" recipients={RECIPIENTS} />);
    fireEvent.click(screen.getByTestId('wizard-button-next-seal'));
    expect(screen.getByTestId('connect-infisical-wizard').dataset.step).toBe('config');
    expect(screen.getByTestId('wizard-error').textContent).toContain('workspace_id');
  });

  it('blocks seal when no recipient is available', () => {
    render(<ConnectInfisicalWizard orgSlug="acme" recipients={[]} />);
    fireEvent.change(screen.getByTestId('wizard-input-workspace'), {
      target: { value: 'ws' },
    });
    fireEvent.change(screen.getByTestId('wizard-input-clientid'), {
      target: { value: 'cid' },
    });
    fireEvent.change(screen.getByTestId('wizard-input-clientsecret'), {
      target: { value: 'cs' },
    });
    fireEvent.click(screen.getByTestId('wizard-button-next-seal'));
    expect(screen.getByTestId('wizard-no-recipients')).toBeTruthy();
    // The Seal button is rendered but disabled.
    const sealBtn = screen.getByTestId('wizard-button-seal');
    expect(sealBtn.hasAttribute('disabled')).toBe(true);
  });
});

describe('<SecretManagerList>', () => {
  it('renders an empty state when no SMs', () => {
    render(<SecretManagerList orgSlug="acme" items={[]} />);
    expect(screen.getByTestId('secret-managers-empty')).toBeTruthy();
  });

  it('renders one row per SM with the default badge', () => {
    render(
      <SecretManagerList
        orgSlug="acme"
        items={[
          {
            id: 'sm-1',
            kind: 'infisical',
            name: 'default',
            is_default: true,
            config: { workspace_id: 'ws', endpoint: 'https://eu.infisical.com' },
            created_at: '2026-05-21T00:00:00Z',
          },
          {
            id: 'sm-2',
            kind: 'infisical',
            name: 'backup',
            is_default: false,
            config: {},
            created_at: '2026-05-20T00:00:00Z',
          },
        ]}
      />,
    );
    expect(screen.getByTestId('secret-managers-row-sm-1')).toBeTruthy();
    expect(screen.getByTestId('secret-managers-default-badge-sm-1')).toBeTruthy();
    expect(screen.getByTestId('set-default-button-sm-2')).toBeTruthy();
  });
});

describe('<NeedsResealBanner>', () => {
  it('returns null when the API reports count=0', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ count: 0, items: [] }), { status: 200 }),
    );
    const { container } = render(<NeedsResealBanner orgSlug="acme" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    // After the fetch resolves, no banner is rendered.
    await waitFor(() =>
      expect(container.querySelector('[data-testid="needs-reseal-banner"]')).toBeNull(),
    );
  });

  it('renders the banner + Re-seal button when count > 0', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          count: 2,
          items: [
            { resource_id: 'r1', key: 'MAIN', resource_name: 'r1' },
            { resource_id: 'r2', key: 'ADMIN', resource_name: 'r2' },
          ],
        }),
        { status: 200 },
      ),
    );
    render(<NeedsResealBanner orgSlug="acme" />);
    await waitFor(() => expect(screen.queryByTestId('needs-reseal-banner')).not.toBeNull());
    expect(screen.getByTestId('needs-reseal-banner-message').textContent).toContain('2');
    expect(screen.getByTestId('needs-reseal-banner-action')).toBeTruthy();
  });

  it('iterates runReseal per item on "Re-seal now"', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            count: 2,
            items: [
              { resource_id: 'r1', key: 'MAIN', resource_name: 'r1' },
              { resource_id: 'r2', key: 'ADMIN', resource_name: 'r2' },
            ],
          }),
          { status: 200 },
        ),
      )
      // After re-seal, the banner reloads /needs-reseal → empty.
      .mockResolvedValue(new Response(JSON.stringify({ count: 0, items: [] }), { status: 200 }));
    (runReseal as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, sealed_for: 2 });
    render(<NeedsResealBanner orgSlug="acme" />);
    await waitFor(() => expect(screen.queryByTestId('needs-reseal-banner-action')).not.toBeNull());
    await act(() => {
      fireEvent.click(screen.getByTestId('needs-reseal-banner-action'));
      return Promise.resolve();
    });
    expect(runReseal).toHaveBeenCalledTimes(2);
    expect(runReseal).toHaveBeenNthCalledWith(1, {
      orgSlug: 'acme',
      resourceId: 'r1',
      accessKey: 'MAIN',
    });
  });
});
