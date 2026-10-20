/**
 * The backup carries the sign-in configuration (ADR
 * backup-carries-the-sign-in-configuration): a copy made on one host, restored on
 * a fresh store whose environment is another, signs people in as the source did.
 */
import { randomBytes } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RESTORED_ADMIN_RULE_KEY } from '../auth/restored-admin-rule';
import { IdpSettingsService } from '../auth/idp-settings';
import { SignInProvidersService } from '../auth/sign-in-providers';
import { loadInstanceConfig, type InstanceConfig } from '../config';
import { validEnv } from '../config/testing';
import { createEncryptor } from '../crypto';
import { openStore, SetCatalogIndex, type Store } from '../store';
import { EXIT_OK, runBackupCli } from './cli';

const KEY = randomBytes(32).toString('base64');
const ENTRA = 'https://login.microsoftonline.com/0b6f0e2a-1111-4222-8333-444455556666/v2.0';
const ENTRA_SECRET = 'entra-secret-' + randomBytes(12).toString('hex');
const OTHER_SECRET = 'host-secret-' + randomBytes(12).toString('hex');
const clock = { now: () => new Date('2026-10-20T10:00:00.000Z') };

const SOURCE_SIGN_IN = {
  VAUBAAN_SIGN_IN_ENTRA_KIND: 'oidc',
  VAUBAAN_SIGN_IN_ENTRA_NAME: 'Fiabilis',
  VAUBAAN_SIGN_IN_ENTRA_ISSUER: ENTRA,
  VAUBAAN_SIGN_IN_ENTRA_CLIENT_ID: 'entra-client',
  VAUBAAN_SIGN_IN_ENTRA_CLIENT_SECRET: ENTRA_SECRET,
  VAUBAAN_SIGN_IN_ENTRA_INVITATION_ONLY: 'true',
  VAUBAAN_SIGN_IN_ENTRA_CLAIM_EMAIL_VERIFIED: 'xms_edov',
  VAUBAAN_SIGN_IN_ENTRA_REQUIRE_VERIFIED_EMAIL: 'true',
  VAUBAAN_SIGN_IN_LOCAL_KIND: 'local',
  VAUBAAN_ADMIN_GROUP: 'entra:admins',
  VAUBAAN_ADMIN_EMAILS: 'boss@fiabilis.example',
};

/** The new host: its own provider and its own admin rule, none of the source's. */
const TARGET_SIGN_IN = {
  VAUBAAN_SIGN_IN_VAUBAAN_KIND: 'oidc',
  VAUBAAN_SIGN_IN_VAUBAAN_ISSUER: 'https://auth.vaubaan.example',
  VAUBAAN_SIGN_IN_VAUBAAN_CLIENT_ID: 'vaubaan-client',
  VAUBAAN_SIGN_IN_VAUBAAN_CLIENT_SECRET: OTHER_SECRET,
  VAUBAAN_SIGN_IN_VAUBAAN_INVITATION_ONLY: 'true',
  VAUBAAN_ADMIN_EMAILS: 'support@vaubaan.example',
};

function load(storePath: string, extra: Record<string, string>) {
  return loadInstanceConfig({
    env: validEnv({
      VAUBAAN_STORE_PATH: storePath,
      VAUBAAN_MASTER_KEY: KEY,
      VAUBAAN_MASTER_KEY_VERSION: '2',
      ...extra,
    }),
  });
}

async function open(path: string, config: InstanceConfig): Promise<Store> {
  const encryptor = await createEncryptor(config.encryption);
  return openStore({ path, encryptor, catalog: new SetCatalogIndex([]) });
}

function providersOf(config: InstanceConfig, store: Store) {
  return {
    service: new SignInProvidersService(
      config,
      async () => [],
      new IdpSettingsService(config.idp, store.config),
      store.config,
      clock,
    ),
  };
}

describe('a backup carries the sign-in configuration', () => {
  let dir: string;
  let sourcePath: string;
  let out = '';
  let err = '';

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'vaubaan-carry-'));
    sourcePath = join(dir, 'gateway.db');
    const store = await open(sourcePath, load(sourcePath, SOURCE_SIGN_IN).config);
    await store.close();
    out = '';
    err = '';
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  async function backup(): Promise<string> {
    const code = await runBackupCli(
      ['copy.sqlite'],
      { stdout: (t) => (out += t), stderr: (t) => (err += t), uid: 10001 },
      { loadConfig: () => load(sourcePath, SOURCE_SIGN_IN), now: clock.now },
    );
    expect(code, err).toBe(EXIT_OK);
    return join(dir, 'copy.sqlite');
  }

  function restoredPath(copy: string): string {
    const targetPath = join(mkdtempSync(join(dir, 'target-')), 'gateway.db');
    // The restore puts the verified copy in place of the store.
    copyFileSync(copy, targetPath);
    return targetPath;
  }

  it('restored on a fresh host with another environment: providers present, secrets sealed', async () => {
    const copy = await backup();
    expect(out).toContain('sign-in provider(s) the configuration sets (entra, local)');
    expect(out).toContain('master key version(s) 2');
    // Never in clear: not in the copy's bytes, not in what the command printed.
    expect(readFileSync(copy).includes(Buffer.from(ENTRA_SECRET))).toBe(false);
    expect(out + err).not.toContain(ENTRA_SECRET);

    // The live store was only read.
    const live = await open(sourcePath, load(sourcePath, SOURCE_SIGN_IN).config);
    expect(await live.config.get('sign_in.entra')).toBeNull();
    expect(await live.config.get(RESTORED_ADMIN_RULE_KEY)).toBeNull();
    await live.close();

    const targetPath = restoredPath(copy);
    const { config } = load(targetPath, TARGET_SIGN_IN);
    const store = await open(targetPath, config);
    try {
      const { service } = providersOf(config, store);
      const views = await service.views();
      expect(views.map((v) => [v.id, v.source])).toEqual([
        ['vaubaan', 'file'],
        ['entra', 'store'],
        ['local', 'store'],
      ]);
      // Editable from Administration → Identity provider: store-held.
      expect(service.isReadOnly('entra')).toBe(false);
      const entra = await service.resolve('entra');
      expect(entra?.source).toBe('store');
      if (entra?.provider.kind !== 'oidc') throw new Error('not oidc');
      expect(entra.provider.clientSecret).toBe(ENTRA_SECRET);
      expect(entra.provider.name).toBe('Fiabilis');
      expect(entra.provider.requireVerifiedEmail).toBe(true);
      expect(entra.provider.claims.emailVerified).toBe('xms_edov');
      expect(entra.provider.invitationOnly).toBe(true);

      // No admin rule is carried: the administrators are rows of the copied store
      // (ADR administrators-live-in-the-instance).
      expect(await store.config.get(RESTORED_ADMIN_RULE_KEY)).toBeNull();

      // An edit in the form keeps what the form does not show.
      await service.save(
        {
          id: 'entra',
          kind: 'oidc',
          name: 'Fiabilis SSO',
          issuer: ENTRA,
          clientId: 'entra-client',
          clientSecret: null,
          allowedEmailDomains: [],
          invitationOnly: true,
        },
        'update',
      );
      const edited = await service.resolve('entra');
      if (edited?.provider.kind !== 'oidc') throw new Error('not oidc');
      expect(edited.provider.name).toBe('Fiabilis SSO');
      expect(edited.provider.requireVerifiedEmail).toBe(true);
      expect(edited.provider.claims.emailVerified).toBe('xms_edov');
      expect(edited.provider.clientSecret).toBe(ENTRA_SECRET);
    } finally {
      await store.close();
    }
  });

  it("the new host's environment wins on an id collision", async () => {
    const targetPath = restoredPath(await backup());
    const { config } = load(targetPath, {
      VAUBAAN_SIGN_IN_ENTRA_KIND: 'oidc',
      VAUBAAN_SIGN_IN_ENTRA_ISSUER: ENTRA,
      VAUBAAN_SIGN_IN_ENTRA_CLIENT_ID: 'new-client',
      VAUBAAN_SIGN_IN_ENTRA_CLIENT_SECRET: OTHER_SECRET,
      VAUBAAN_SIGN_IN_ENTRA_INVITATION_ONLY: 'true',
      VAUBAAN_ADMIN_GROUP: 'entra:operators',
    });
    const store = await open(targetPath, config);
    try {
      const { service } = providersOf(config, store);
      const entra = await service.resolve('entra');
      expect(entra?.source).toBe('file');
      if (entra?.provider.kind !== 'oidc') throw new Error('not oidc');
      expect(entra.provider.clientSecret).toBe(OTHER_SECRET);
      expect((await service.views()).filter((v) => v.id === 'entra')).toHaveLength(1);
    } finally {
      await store.close();
    }
  });

  it('a backup of a restored instance carries its providers again', async () => {
    const targetPath = restoredPath(await backup());
    let second = '';
    const code = await runBackupCli(
      ['again.sqlite'],
      { stdout: (t) => (second += t), stderr: (t) => (second += t), uid: 10001 },
      { loadConfig: () => load(targetPath, TARGET_SIGN_IN), now: clock.now },
    );
    expect(code, second).toBe(EXIT_OK);
    const againPath = join(targetPath, '..', 'again.sqlite');
    const { config } = load(againPath, {});
    const store = await open(againPath, config);
    try {
      const { service } = providersOf(config, store);
      expect(await store.config.get(RESTORED_ADMIN_RULE_KEY)).toBeNull();
      expect((await service.views()).map((v) => v.id).sort()).toEqual([
        'entra',
        'local',
        'vaubaan',
      ]);
    } finally {
      await store.close();
    }
  });
});
