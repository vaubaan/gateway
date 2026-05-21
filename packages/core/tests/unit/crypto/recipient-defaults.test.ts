import { describe, it, expect } from 'vitest';

import { defaultRecipients } from '../../../src/crypto/recipient-defaults.js';
import { type PubKeyEntry } from '../../../src/crypto/types.js';

function fakePubKey(fingerprint: string): PubKeyEntry {
  return { publicKey: new Uint8Array(32), fingerprint };
}

describe('defaultRecipients (spec §4.4)', () => {
  const alice = fakePubKey('aaaa1111aaaa1111aaaa1111aaaa1111');
  const bob = fakePubKey('bbbb2222bbbb2222bbbb2222bbbb2222');
  const runner = fakePubKey('9999runner9999runner9999runner99');

  it('member-only resource without a known runner → list = members', () => {
    const out = defaultRecipients({
      orgMembers: [alice, bob],
      isOrgAdminResource: false,
    });
    expect(out.map((r) => r.fingerprint)).toEqual([alice.fingerprint, bob.fingerprint]);
  });

  it('project resource with a runner → list = members + runner', () => {
    const out = defaultRecipients({
      orgMembers: [alice, bob],
      runner,
      isOrgAdminResource: false,
    });
    expect(out.map((r) => r.fingerprint)).toEqual([
      alice.fingerprint,
      bob.fingerprint,
      runner.fingerprint,
    ]);
  });

  it('org-admin resource with a runner → runner is excluded', () => {
    const out = defaultRecipients({
      orgMembers: [alice, bob],
      runner,
      isOrgAdminResource: true,
    });
    expect(out.map((r) => r.fingerprint)).toEqual([alice.fingerprint, bob.fingerprint]);
  });

  it('empty members + no runner → empty list', () => {
    const out = defaultRecipients({
      orgMembers: [],
      isOrgAdminResource: false,
    });
    expect(out).toHaveLength(0);
  });
});
