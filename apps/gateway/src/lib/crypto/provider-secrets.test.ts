import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import { encryptProviderSecret, decryptProviderSecret, _resetMasterKey } from './provider-secrets';

const TEST_KEY = randomBytes(32).toString('base64');
const ORG_A = '00000000-0000-0000-0000-000000000001';
const ORG_B = '00000000-0000-0000-0000-000000000002';

beforeAll(() => {
  process.env.ENCRYPTION_MASTER_KEY = TEST_KEY;
  _resetMasterKey();
});
afterAll(() => {
  delete process.env.ENCRYPTION_MASTER_KEY;
  _resetMasterKey();
});

describe('provider-secrets crypto', () => {
  it('round-trips encrypt then decrypt', async () => {
    const plaintext = 'gho_secret_token_abc123';
    const encrypted = await encryptProviderSecret(ORG_A, plaintext);
    const decrypted = await decryptProviderSecret(ORG_A, encrypted);
    expect(decrypted).toBe(plaintext);
  });

  it('produces different ciphertexts for the same plaintext (random nonce)', async () => {
    const plaintext = 'same-token';
    const a = await encryptProviderSecret(ORG_A, plaintext);
    const b = await encryptProviderSecret(ORG_A, plaintext);
    expect(Buffer.compare(a, b)).not.toBe(0);
  });

  it('rejects cross-org decryption (AAD mismatch)', async () => {
    const encrypted = await encryptProviderSecret(ORG_A, 'secret');
    await expect(decryptProviderSecret(ORG_B, encrypted)).rejects.toThrow();
  });

  it('rejects tampered ciphertext', async () => {
    const encrypted = await encryptProviderSecret(ORG_A, 'secret');
    encrypted[encrypted.length - 1]! ^= 0xff;
    await expect(decryptProviderSecret(ORG_A, encrypted)).rejects.toThrow();
  });

  it('rejects too-short ciphertext', async () => {
    await expect(decryptProviderSecret(ORG_A, Buffer.alloc(10))).rejects.toThrow('too short');
  });

  it('throws when ENCRYPTION_MASTER_KEY is missing', async () => {
    const saved = process.env.ENCRYPTION_MASTER_KEY;
    delete process.env.ENCRYPTION_MASTER_KEY;
    _resetMasterKey();
    await expect(encryptProviderSecret(ORG_A, 'x')).rejects.toThrow('ENCRYPTION_MASTER_KEY');
    process.env.ENCRYPTION_MASTER_KEY = saved;
    _resetMasterKey();
  });

  it('throws when ENCRYPTION_MASTER_KEY has wrong length', async () => {
    const saved = process.env.ENCRYPTION_MASTER_KEY;
    process.env.ENCRYPTION_MASTER_KEY = randomBytes(16).toString('base64');
    _resetMasterKey();
    await expect(encryptProviderSecret(ORG_A, 'x')).rejects.toThrow('32 bytes');
    process.env.ENCRYPTION_MASTER_KEY = saved;
    _resetMasterKey();
  });

  it('handles empty plaintext', async () => {
    const encrypted = await encryptProviderSecret(ORG_A, '');
    const decrypted = await decryptProviderSecret(ORG_A, encrypted);
    expect(decrypted).toBe('');
  });

  it('handles unicode plaintext', async () => {
    const plaintext = '🔐 clé secrète éàü';
    const encrypted = await encryptProviderSecret(ORG_A, plaintext);
    const decrypted = await decryptProviderSecret(ORG_A, encrypted);
    expect(decrypted).toBe(plaintext);
  });
});
