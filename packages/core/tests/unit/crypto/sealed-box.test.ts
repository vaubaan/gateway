import { describe, it, expect } from 'vitest';

import { generateUserKeypair } from '../../../src/crypto/keypair.js';
import { decodeUtf8, sealForRecipients, unsealAs } from '../../../src/crypto/sealed-box.js';

describe('sealForRecipients / unsealAs', () => {
  it('lets every listed recipient unseal the original cleartext', async () => {
    const alice = await generateUserKeypair();
    const bob = await generateUserKeypair();
    const carol = await generateUserKeypair();
    const plaintext = 'ghp_super_secret_personal_access_token';
    const blob = await sealForRecipients(plaintext, [alice, bob, carol]);

    expect(blob.v).toBe(1);
    expect(blob.recipients).toHaveLength(3);

    for (const recipient of [alice, bob, carol]) {
      const out = await unsealAs(blob, recipient.fingerprint, recipient);
      expect(out).not.toBeNull();
      expect(decodeUtf8(out as Uint8Array)).toBe(plaintext);
    }
  });

  it('returns null for a non-recipient', async () => {
    const alice = await generateUserKeypair();
    const bob = await generateUserKeypair();
    const carol = await generateUserKeypair();
    const eve = await generateUserKeypair();
    const blob = await sealForRecipients('top-secret', [alice, bob, carol]);
    const out = await unsealAs(blob, eve.fingerprint, eve);
    expect(out).toBeNull();
  });

  it('returns null when an entry is tampered', async () => {
    const alice = await generateUserKeypair();
    const blob = await sealForRecipients('top-secret', [alice]);
    const aliceEntry = blob.recipients[0];
    expect(aliceEntry).toBeDefined();
    // Flip one base64 character (still legal base64, but ciphertext-corrupt).
    const ct = aliceEntry!.ct;
    const flipped = ct.startsWith('A') ? 'B' + ct.slice(1) : 'A' + ct.slice(1);
    const tampered = {
      v: 1 as const,
      recipients: [{ fp: aliceEntry!.fp, ct: flipped }],
    };
    const out = await unsealAs(tampered, alice.fingerprint, alice);
    expect(out).toBeNull();
  });
});
