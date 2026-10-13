/**
 * Test helpers for the store. Not for production: `StubEncryptor` is NOT encryption, it
 * only reproduces the contract of the crypto module's `Encryptor` (associated-data
 * binding, key version) so repository tests can assert it without a master key.
 */

import { createHash } from 'node:crypto';
import { SetCatalogIndex } from './catalog-index.ts';
import { ManualClock } from './clock.ts';
import type { EncryptedBlob, Encryptor } from './encryptor.ts';
import { openMemoryStore, type Store } from './index.ts';
import type { RiskId } from './types.ts';

const TAG_BYTES = 8;

export class StubEncryptor implements Encryptor {
  readonly sealCalls: { associatedData: string }[] = [];

  constructor(readonly currentKeyVersion: number = 1) {}

  async encrypt(associatedData: string, plaintext: string): Promise<EncryptedBlob> {
    this.sealCalls.push({ associatedData });
    return {
      keyVersion: this.currentKeyVersion,
      blob: Buffer.concat([
        this.tag(associatedData, this.currentKeyVersion),
        Buffer.from(plaintext, 'utf8'),
      ]),
    };
  }

  async decrypt(associatedData: string, sealed: EncryptedBlob): Promise<string> {
    const blob = Buffer.from(sealed.blob);
    const expected = this.tag(associatedData, sealed.keyVersion);
    if (blob.length < TAG_BYTES || !blob.subarray(0, TAG_BYTES).equals(expected)) {
      throw new Error('StubEncryptor: associated data mismatch');
    }
    return blob.subarray(TAG_BYTES).toString('utf8');
  }

  private tag(associatedData: string, keyVersion: number): Buffer {
    return createHash('sha256')
      .update(`v${keyVersion}:${associatedData}`)
      .digest()
      .subarray(0, TAG_BYTES);
  }
}

/** A small catalog every store test can rely on. */
export const TEST_RISK_IDS: readonly RiskId[] = [
  'github.code-read',
  'github.write-feature-branch',
  'github.merge-protected',
  'supabase[prod].bulk-row-write',
  'supabase[staging].bulk-row-write',
];

export interface TestStoreOptions {
  readonly riskIds?: readonly RiskId[];
  readonly clock?: ManualClock;
  readonly encryptor?: StubEncryptor;
}

export interface TestStore {
  readonly store: Store;
  readonly clock: ManualClock;
  readonly encryptor: StubEncryptor;
}

export function openTestStore(options: TestStoreOptions = {}): TestStore {
  const clock = options.clock ?? new ManualClock();
  const encryptor = options.encryptor ?? new StubEncryptor();
  const store = openMemoryStore({
    encryptor,
    catalog: new SetCatalogIndex(options.riskIds ?? TEST_RISK_IDS),
    clock,
  });
  return { store, clock, encryptor };
}
