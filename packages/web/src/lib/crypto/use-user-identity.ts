'use client';

/**
 * useUserIdentity — React hook orchestrating the spec §4.1 bootstrap
 * flow on the browser:
 *
 *   1. GET /api/crm/v1/me/crypto-key
 *   2. if 404 → generate a fresh keypair + POST (first login on any
 *      device of this user); if 200 → derive KEK + unwrap.
 *   3. cache the unwrapped identity in `identityStore` (memory only).
 *
 * The hook never exposes the raw `privateKey` to consumers — only the
 * pubkey and fingerprint. Code that needs to seal/unseal asks the
 * `identityStore` directly (kept in the same package so callers stay
 * on the same trust boundary).
 *
 * Spec §4.1.1 forbids localStorage / sessionStorage / IndexedDB for
 * the sk — there is none in this file, by design.
 */

import { useState } from 'react';

import {
  deriveKEK,
  generateUserKeypair,
  type KdfParams,
  unwrapPrivateKey,
  wrapPrivateKey,
} from '@crm/core/crypto';

import { identityStore, type Identity } from './identity-store';

export type IdentityState = 'absent' | 'locked' | 'unlocked';

export interface PublicIdentity {
  readonly publicKey: Uint8Array;
  readonly fingerprint: string;
}

interface CryptoKeyResponse {
  public_key: string;
  fingerprint: string;
  wrapped_private_key: string;
  kdf_salt: string;
  kdf_params?: { m: number; t: number; p: number; alg?: string };
}

const ENDPOINT = '/api/crm/v1/me/crypto-key';
const SALT_BYTES = 16;
const DEFAULT_PARAMS: KdfParams = { m: 67108864, t: 3, p: 1 };

function base64Decode(input: string): Uint8Array {
  const bin = globalThis.atob(input);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function base64Encode(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return globalThis.btoa(bin);
}

function publicView(id: Identity): PublicIdentity {
  return { publicKey: id.publicKey, fingerprint: id.fingerprint };
}

export interface UseUserIdentity {
  state: IdentityState;
  identity: PublicIdentity | null;
  unlock: (password: string) => Promise<void>;
  lock: () => void;
  initOrUnlock: (password: string) => Promise<{ created: boolean }>;
}

export function useUserIdentity(): UseUserIdentity {
  const initial = identityStore.get();
  const [state, setState] = useState<IdentityState>(initial ? 'unlocked' : 'absent');
  const [identity, setIdentity] = useState<PublicIdentity | null>(
    initial ? publicView(initial) : null,
  );

  function commit(id: Identity): void {
    identityStore.set(id);
    setIdentity(publicView(id));
    setState('unlocked');
  }

  function fail(err: unknown): never {
    setState(identityStore.get() ? 'unlocked' : 'absent');
    throw err instanceof Error ? err : new Error('identity error');
  }

  const lock = (): void => {
    identityStore.clear();
    setIdentity(null);
    setState('absent');
  };

  async function unlock(passwordIn: string): Promise<void> {
    setState('locked');
    let pw = passwordIn;
    try {
      const res = await fetch(ENDPOINT, { method: 'GET' });
      if (res.status === 404) {
        await initOrUnlock(pw);
        pw = '';
        return;
      }
      if (!res.ok) {
        throw new Error(`failed to fetch crypto identity (HTTP ${String(res.status)})`);
      }
      const data = (await res.json()) as CryptoKeyResponse;
      const salt = base64Decode(data.kdf_salt);
      const params: KdfParams = data.kdf_params
        ? { m: data.kdf_params.m, t: data.kdf_params.t, p: data.kdf_params.p }
        : DEFAULT_PARAMS;
      const kek = await deriveKEK(pw, salt, params);
      pw = '';
      const wrapped = base64Decode(data.wrapped_private_key);
      const sk = await unwrapPrivateKey(wrapped, kek);
      if (sk === null) {
        throw new Error('wrong password');
      }
      commit({
        publicKey: base64Decode(data.public_key),
        privateKey: sk,
        fingerprint: data.fingerprint,
      });
    } catch (err) {
      pw = '';
      fail(err);
    }
  }

  async function initOrUnlock(passwordIn: string): Promise<{ created: boolean }> {
    setState('locked');
    let pw = passwordIn;
    try {
      const kp = await generateUserKeypair();
      const salt = globalThis.crypto.getRandomValues(new Uint8Array(SALT_BYTES));
      const kek = await deriveKEK(pw, salt, DEFAULT_PARAMS);
      const wrapped = await wrapPrivateKey(kp.privateKey, kek);
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          public_key: base64Encode(kp.publicKey),
          fingerprint: kp.fingerprint,
          wrapped_private_key: base64Encode(wrapped),
          kdf_salt: base64Encode(salt),
        }),
      });
      if (res.status === 409) {
        // Another device/tab raced us. Fall back to the regular unlock
        // path against whatever the server now stores.
        await unlock(pw);
        pw = '';
        return { created: false };
      }
      if (!res.ok) {
        throw new Error(`failed to create crypto identity (HTTP ${String(res.status)})`);
      }
      pw = '';
      commit({
        publicKey: kp.publicKey,
        privateKey: kp.privateKey,
        fingerprint: kp.fingerprint,
      });
      return { created: true };
    } catch (err) {
      pw = '';
      fail(err);
    }
  }

  return { state, identity, unlock, lock, initOrUnlock };
}
