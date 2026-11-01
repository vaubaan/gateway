/**
 * What a password check costs (security audit 2026-10-31, M2): an unknown address
 * and a wrong password cost one hash each, so they cannot be told apart by timing;
 * a locked account costs none, so anonymous posts against it buy no hash.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { argon2Passwords, type PasswordHasher } from '../crypto/password';
import { silentLogger } from '../logging/logger';
import { openTestStore, type TestStore } from '../../../tests/support/store/testing';
import { LOCAL_LOCKOUT, LocalAccountsService } from './local-accounts';

const PROVIDER = 'local';
const ADA = 'ada@example.com';
const PASSWORD = 'a sentence ada remembers';

/** The real hashing, counting the checks it runs. */
class CountingPasswords implements PasswordHasher {
  verifications = 0;
  hash(password: string): Promise<string> {
    return argon2Passwords.hash(password);
  }
  verify(hash: string, password: string): Promise<boolean> {
    this.verifications += 1;
    return argon2Passwords.verify(hash, password);
  }
  verifyDecoy(password: string): Promise<boolean> {
    this.verifications += 1;
    return argon2Passwords.verifyDecoy(password);
  }
}

describe('the cost of a password check', () => {
  let test: TestStore;
  let passwords: CountingPasswords;
  let accounts: LocalAccountsService;

  beforeEach(async () => {
    test = openTestStore();
    passwords = new CountingPasswords();
    accounts = new LocalAccountsService({
      store: test.store,
      audit: test.store.auditWriter,
      clock: test.clock,
      logger: silentLogger,
      publicUrl: new URL('https://gateway.example.com'),
      passwords,
    });
    await accounts.createAccount({
      providerId: PROVIDER,
      email: ADA,
      password: PASSWORD,
      actor: 'bootstrap',
    });
  });
  afterEach(async () => {
    await test.store.close();
  });

  it('an unknown address and a wrong password each cost one hash, and get one answer', async () => {
    expect(await accounts.checkPassword(PROVIDER, 'bob@example.com', PASSWORD)).toEqual({
      ok: false,
      cause: 'unknown',
    });
    expect(passwords.verifications).toBe(1);
    expect(await accounts.checkPassword(PROVIDER, ADA, 'not the sentence')).toEqual({
      ok: false,
      cause: 'wrong',
    });
    expect(passwords.verifications).toBe(2);
  });

  it('a locked account is refused before any hash, the right password included', async () => {
    for (let miss = 0; miss < LOCAL_LOCKOUT.maxAttempts; miss += 1) {
      await accounts.checkPassword(PROVIDER, ADA, 'not the sentence');
    }
    const before = passwords.verifications;
    expect(await accounts.checkPassword(PROVIDER, ADA, PASSWORD)).toEqual({
      ok: false,
      cause: 'locked',
    });
    expect(passwords.verifications).toBe(before);
    test.clock.advance(LOCAL_LOCKOUT.lockMs + 1);
    expect(await accounts.checkPassword(PROVIDER, ADA, PASSWORD)).toMatchObject({ ok: true });
  });
});
