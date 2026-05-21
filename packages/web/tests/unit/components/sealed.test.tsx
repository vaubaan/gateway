/**
 * Unit tests for the sealed UI components (`<SealedInput>`,
 * `<SealedReveal>`, `<SealedView>`) — Phase 4 wave B.
 *
 * jsdom environment (configured via vitest.config.ts
 * `environmentMatchGlobs`). The `/recipients` endpoint is faked via
 * `global.fetch`. The `@crm/core/crypto` primitives are mocked at the
 * boundary: the round-trip correctness of `sealForRecipients` /
 * `unsealAs` is already covered exhaustively in
 * `packages/core/tests/unit/crypto/sealed-box.test.ts`. Here we only
 * assert the component contract — wiring, ZK invariants, recipient
 * UX, wipe behaviour after `onSealed`.
 *
 * Spec docs/spec/cloud-resource-manager.md §4.3, §4.4, §11.2.
 */

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';

import { type SealedBlobV1 } from '@crm/core/crypto';

import { SealedInput } from '@/components/sealed/SealedInput';
import { SealedReveal } from '@/components/sealed/SealedReveal';
import { SealedView } from '@/components/sealed/SealedView';
import { __resetDefaultRecipientsCache } from '@/lib/sealed/use-default-recipients';
import { identityStore } from '@/lib/crypto/identity-store';

// Hoisted state used by the `@crm/core/crypto` mock — the mock factory
// runs at module-load time, before any test (so `vi.hoisted` wraps
// references that we want to mutate from beforeEach).
const cryptoState = vi.hoisted(() => ({
  // sealForRecipients: returns a deterministic SealedBlobV1 mirroring
  // the input recipients[]. Captures the cleartext bytes argument for
  // assertions.
  lastSealed: null as { cleartext: Uint8Array; recipients: ReadonlyArray<{ fp: string }> } | null,
  // unsealAs: returns this cleartext if the fingerprint matches the
  // current recipient.
  storedPlaintext: new TextEncoder().encode('hello-world'),
  unsealMatches: true,
}));

vi.mock('@crm/core/crypto', () => ({
  sealForRecipients: (
    plaintext: Uint8Array | string,
    recipients: ReadonlyArray<{ publicKey: Uint8Array; fingerprint: string }>,
  ): Promise<SealedBlobV1> => {
    // Keep a *reference* (not a copy) to the cleartext bytes so the wipe
    // test can verify the component's `bytes.fill(0)` actually mutated
    // the buffer it passed in.
    if (typeof plaintext !== 'string') {
      cryptoState.lastSealed = {
        cleartext: plaintext,
        recipients: recipients.map((r) => ({ fp: r.fingerprint })),
      };
    } else {
      cryptoState.lastSealed = {
        cleartext: new TextEncoder().encode(plaintext),
        recipients: recipients.map((r) => ({ fp: r.fingerprint })),
      };
    }
    return Promise.resolve({
      v: 1,
      recipients: recipients.map((r) => ({ fp: r.fingerprint, ct: 'AAAAAAAA' })),
    });
  },
  unsealAs: (
    _blob: SealedBlobV1,
    _ownFp: string,
    _kp: { publicKey: Uint8Array; privateKey: Uint8Array },
  ): Promise<Uint8Array | null> => {
    if (!cryptoState.unsealMatches) return Promise.resolve(null);
    return Promise.resolve(new Uint8Array(cryptoState.storedPlaintext));
  },
  decodeUtf8: (bytes: Uint8Array): string => new TextDecoder().decode(bytes),
}));

interface RecipientWire {
  readonly user_id?: string;
  readonly public_key: string;
  readonly fingerprint: string;
}

function bytesToBase64(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]!);
  return btoa(s);
}

function stringifyRequestInput(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function mockRecipientsEndpoint(recipients: ReadonlyArray<RecipientWire>): void {
  const fetchImpl: typeof fetch = (input) => {
    const url = stringifyRequestInput(input);
    if (url.includes('/recipients')) {
      return Promise.resolve(
        new Response(JSON.stringify({ defaults: recipients }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }
    return Promise.resolve(new Response('not found', { status: 404 }));
  };
  global.fetch = vi.fn(fetchImpl);
}

async function flushAsyncEffects(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  });
}

function fakeFingerprint(prefix: string): string {
  return (prefix + 'a'.repeat(32)).slice(0, 32);
}

function fakePublicKey(): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = i;
  return out;
}

describe('<SealedInput>', () => {
  beforeEach(() => {
    __resetDefaultRecipientsCache();
    identityStore.clear();
    cryptoState.lastSealed = null;
    cryptoState.unsealMatches = true;
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders recipients fetched from /recipients', async () => {
    const fp = fakeFingerprint('1');
    mockRecipientsEndpoint([
      { user_id: 'user-alice', public_key: bytesToBase64(fakePublicKey()), fingerprint: fp },
    ]);
    const onSealed = vi.fn((_blob: SealedBlobV1): Promise<void> => Promise.resolve());
    render(<SealedInput resourceId="res-1" accessKey="GITHUB_TOKEN" onSealed={onSealed} />);
    await flushAsyncEffects();
    expect(screen.getByTestId(`recipient-fp-${fp}`)).toBeTruthy();
    const root = screen.getByTestId('sealed-input');
    expect(root.getAttribute('data-status')).toBe('ready');
    expect(root.getAttribute('data-recipient-count')).toBe('1');
  });

  it('seals the textarea bytes and wipes state after onSealed resolves', async () => {
    const fp = fakeFingerprint('2');
    mockRecipientsEndpoint([
      { user_id: 'user-alice', public_key: bytesToBase64(fakePublicKey()), fingerprint: fp },
    ]);
    let captured: SealedBlobV1 | null = null;
    const onSealed = vi.fn((blob: SealedBlobV1): Promise<void> => {
      captured = blob;
      return Promise.resolve();
    });
    render(<SealedInput resourceId="res-1" accessKey="GITHUB_TOKEN" onSealed={onSealed} />);
    await flushAsyncEffects();

    const ta = screen.getByTestId('sealed-input-textarea');
    fireEvent.change(ta, { target: { value: 'github_pat_supersecret' } });

    await act(async () => {
      screen.getByTestId('sealed-input-seal').click();
      for (let i = 0; i < 8; i++) await Promise.resolve();
    });

    expect(onSealed).toHaveBeenCalledTimes(1);
    expect(captured).not.toBeNull();
    expect(captured!.v).toBe(1);
    expect(captured!.recipients).toHaveLength(1);
    expect(captured!.recipients[0]!.fp).toBe(fp);
    expect((ta as HTMLTextAreaElement).value).toBe('');
    // The mock keeps a reference to the cleartext bytes the component
    // passed in. The component wipes them after `onSealed` returns;
    // assert that wipe happened.
    expect(cryptoState.lastSealed).not.toBeNull();
    expect(cryptoState.lastSealed!.cleartext.every((b) => b === 0)).toBe(true);
  });

  it('allows excluding a recipient via the checkbox', async () => {
    const fpA = fakeFingerprint('3');
    const fpB = fakeFingerprint('4');
    mockRecipientsEndpoint([
      { user_id: 'user-alice', public_key: bytesToBase64(fakePublicKey()), fingerprint: fpA },
      { user_id: 'user-bob', public_key: bytesToBase64(fakePublicKey()), fingerprint: fpB },
    ]);
    let captured: SealedBlobV1 | null = null;
    const onSealed = vi.fn((blob: SealedBlobV1): Promise<void> => {
      captured = blob;
      return Promise.resolve();
    });
    render(<SealedInput resourceId="res-1" accessKey="GITHUB_TOKEN" onSealed={onSealed} />);
    await flushAsyncEffects();
    const bobCheck = screen.getByTestId(`recipient-checkbox-${fpB}`);
    fireEvent.click(bobCheck);
    const ta = screen.getByTestId('sealed-input-textarea');
    fireEvent.change(ta, { target: { value: 'x' } });
    await act(async () => {
      screen.getByTestId('sealed-input-seal').click();
      for (let i = 0; i < 8; i++) await Promise.resolve();
    });
    expect(captured).not.toBeNull();
    expect(captured!.recipients).toHaveLength(1);
    expect(captured!.recipients[0]!.fp).toBe(fpA);
  });

  it('disables the Seal button when no recipients are selected', async () => {
    const fpA = fakeFingerprint('5');
    mockRecipientsEndpoint([
      { user_id: 'u', public_key: bytesToBase64(fakePublicKey()), fingerprint: fpA },
    ]);
    render(
      <SealedInput
        resourceId="res-1"
        accessKey="GITHUB_TOKEN"
        onSealed={() => Promise.resolve()}
      />,
    );
    await flushAsyncEffects();
    const ta = screen.getByTestId('sealed-input-textarea');
    fireEvent.change(ta, { target: { value: 'value' } });
    fireEvent.click(screen.getByTestId(`recipient-checkbox-${fpA}`));
    const btn = screen.getByTestId('sealed-input-seal');
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('<SealedReveal>', () => {
  beforeEach(() => {
    identityStore.clear();
    cryptoState.unsealMatches = true;
    cryptoState.storedPlaintext = new TextEncoder().encode('hello-world');
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  function dummyBlob(): SealedBlobV1 {
    return {
      v: 1,
      recipients: [{ fp: fakeFingerprint('6'), ct: 'AAAAAAAA' }],
    };
  }

  it('reveals the cleartext when the user is a recipient', async () => {
    identityStore.set({
      publicKey: fakePublicKey(),
      privateKey: fakePublicKey(),
      fingerprint: fakeFingerprint('6'),
    });
    render(<SealedReveal blob={dummyBlob()} mode="reveal" />);
    await act(async () => {
      screen.getByTestId('sealed-reveal-show').click();
      for (let i = 0; i < 5; i++) await Promise.resolve();
    });
    const shown = screen.getByTestId('sealed-reveal-shown');
    expect(shown.textContent).toContain('hello-world');
  });

  it('surfaces not_a_recipient when the user fingerprint is not in the blob', async () => {
    cryptoState.unsealMatches = false;
    identityStore.set({
      publicKey: fakePublicKey(),
      privateKey: fakePublicKey(),
      fingerprint: fakeFingerprint('9'),
    });
    render(<SealedReveal blob={dummyBlob()} mode="reveal" />);
    await act(async () => {
      screen.getByTestId('sealed-reveal-show').click();
      for (let i = 0; i < 5; i++) await Promise.resolve();
    });
    const err = screen.getByTestId('sealed-reveal-error');
    expect(err.textContent).toContain('not a recipient');
  });

  it('surfaces identity_locked when no identity is in the store', async () => {
    render(<SealedReveal blob={dummyBlob()} mode="reveal" />);
    await act(async () => {
      screen.getByTestId('sealed-reveal-show').click();
      for (let i = 0; i < 5; i++) await Promise.resolve();
    });
    const err = screen.getByTestId('sealed-reveal-error');
    expect(err.textContent?.toLowerCase()).toContain('unlock');
  });
});

describe('<SealedView>', () => {
  afterEach(() => {
    cleanup();
  });

  it('shows "sealed for N recipients" summary by default', () => {
    const blob: SealedBlobV1 = {
      v: 1,
      recipients: [
        { fp: fakeFingerprint('a'), ct: 'AAAAAAAA' },
        { fp: fakeFingerprint('b'), ct: 'BBBBBBBB' },
      ],
    };
    render(<SealedView blob={blob} label="GITHUB_TOKEN" />);
    const summary = screen.getByTestId('sealed-view-summary');
    expect(summary.textContent).toBe('sealed for 2 recipients');
  });

  it('toggles the SealedReveal sub-component on click', () => {
    const blob: SealedBlobV1 = {
      v: 1,
      recipients: [{ fp: fakeFingerprint('c'), ct: 'AAAAAAAA' }],
    };
    render(<SealedView blob={blob} />);
    expect(screen.queryByTestId('sealed-reveal-show')).toBeNull();
    fireEvent.click(screen.getByTestId('sealed-view-toggle'));
    expect(screen.getByTestId('sealed-reveal-show')).toBeTruthy();
  });
});

describe('ZK invariants — no persistent storage touched by sealed components', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('SealedInput mount + seal does not touch localStorage or sessionStorage', async () => {
    const lsSpy = vi.spyOn(window.localStorage.__proto__ as Storage, 'setItem');
    const ssSpy = vi.spyOn(window.sessionStorage.__proto__ as Storage, 'setItem');
    const fp = fakeFingerprint('d');
    mockRecipientsEndpoint([
      { user_id: 'u', public_key: bytesToBase64(fakePublicKey()), fingerprint: fp },
    ]);
    render(<SealedInput resourceId="r" accessKey="X_TOKEN" onSealed={() => Promise.resolve()} />);
    await flushAsyncEffects();
    const ta = screen.getByTestId('sealed-input-textarea');
    fireEvent.change(ta, { target: { value: 'value' } });
    await act(async () => {
      screen.getByTestId('sealed-input-seal').click();
      for (let i = 0; i < 6; i++) await Promise.resolve();
    });
    expect(lsSpy).not.toHaveBeenCalled();
    expect(ssSpy).not.toHaveBeenCalled();
  });
});

// Provide a clipboard stub for jsdom (which omits it).
if (typeof navigator !== 'undefined' && !('clipboard' in navigator)) {
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: (): Promise<void> => Promise.resolve() },
    configurable: true,
  });
}
