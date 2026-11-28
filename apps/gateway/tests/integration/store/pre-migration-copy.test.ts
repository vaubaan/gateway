import { copyFileSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

import { openStore, SetCatalogIndex } from '../../../src/server/store';
import { systemClock } from '../../../src/server/store/clock';
import { openDb, openReadonlyDb } from '../../../src/server/store/db';
import {
  compareWithShipped,
  DEFAULT_MIGRATIONS_DIR,
  loadMigrations,
  runMigrations,
} from '../../../src/server/store/migrate';
import { StubEncryptor, TEST_RISK_IDS } from '../../support/store/testing';

// ADR store-copied-before-a-migration; intent "Go back to the former version after an update".
it('an upgrade leaves a copy the former image opens as its own store', () => {
  const shipped = loadMigrations();
  const latest = Math.max(...shipped.map((m) => m.version));
  // The former image: every shipped migration but the latest.
  const formerDir = mkdtempSync(join(tmpdir(), 'former-image-migrations-'));
  for (const file of readdirSync(DEFAULT_MIGRATIONS_DIR)) {
    if (/^\d{4}_.*\.sql$/.test(file) && Number(file.slice(0, 4)) !== latest) {
      copyFileSync(join(DEFAULT_MIGRATIONS_DIR, file), join(formerDir, file));
    }
  }
  const dir = mkdtempSync(join(tmpdir(), 'upgrade-'));
  const path = join(dir, 'gateway.sqlite');
  const former = openDb({ path });
  runMigrations(former, loadMigrations(formerDir), systemClock);
  former.close();

  // This image starts on it.
  const store = openStore({
    path,
    encryptor: new StubEncryptor(),
    catalog: new SetCatalogIndex(TEST_RISK_IDS),
  });
  const copy = store.preMigrationCopy;
  expect(store.schemaVersion).toBe(latest);
  void store.close();

  expect(copy).toMatchObject({ from: latest - 1, to: latest });
  // What the former image checks at boot: nothing it does not know, nothing changed.
  const copied = openReadonlyDb(copy!.path);
  try {
    expect(compareWithShipped(copied, loadMigrations(formerDir))).toMatchObject({
      hasMigrationsTable: true,
      version: latest - 1,
      unknown: [],
      changed: [],
    });
  } finally {
    copied.close();
  }
});
