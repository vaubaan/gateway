#!/usr/bin/env tsx
/**
 * One-shot data migration: encrypt existing plaintext bytea tokens with
 * app-level libsodium encryption.
 *
 * Idempotent: attempts decryption first — if it succeeds, the row is
 * already encrypted and is skipped.
 *
 * Usage:
 *   ENCRYPTION_MASTER_KEY=<base64> tsx scripts/migrate-encrypt-tokens.ts
 *
 * Reads SUPABASE_CORE_PROJECT_REF and VAUBAAN_CORE_DB_PASSWORD from .env.
 */

import { Client } from 'pg';
import {
  encryptProviderSecret,
  decryptProviderSecret,
} from '../packages/web/src/lib/crypto/provider-secrets.ts';
import { readCoreEnv, SUPABASE_POOLER_HOST } from './lib/env.ts';

interface Row {
  id: string;
  organization_id: string;
  access_token_encrypted: Buffer | null;
  refresh_token_encrypted: Buffer | null;
}

async function main() {
  if (!process.env.ENCRYPTION_MASTER_KEY) {
    throw new Error('ENCRYPTION_MASTER_KEY env var is required');
  }

  const core = readCoreEnv();
  const client = new Client({
    host: SUPABASE_POOLER_HOST,
    port: 5432,
    database: 'postgres',
    user: `postgres.${core.projectRef}`,
    password: core.dbPassword,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  try {
    const { rows } = await client.query<Row>(
      `SELECT id, organization_id, access_token_encrypted, refresh_token_encrypted
       FROM provider_admins
       WHERE access_token_encrypted IS NOT NULL
          OR refresh_token_encrypted IS NOT NULL`,
    );

    let migrated = 0;
    let skipped = 0;

    for (const row of rows) {
      const probeColumn = row.access_token_encrypted ?? row.refresh_token_encrypted;
      if (probeColumn) {
        try {
          await decryptProviderSecret(row.organization_id, probeColumn);
          skipped++;
          console.log(`  skip ${row.id} (already encrypted)`);
          continue;
        } catch {
          // Not yet encrypted — proceed with migration
        }
      }

      const updates: Record<string, Buffer | null> = {};

      if (row.access_token_encrypted) {
        const plaintext = row.access_token_encrypted.toString('utf8');
        updates.access_token_encrypted = await encryptProviderSecret(
          row.organization_id,
          plaintext,
        );
      }
      if (row.refresh_token_encrypted) {
        const plaintext = row.refresh_token_encrypted.toString('utf8');
        updates.refresh_token_encrypted = await encryptProviderSecret(
          row.organization_id,
          plaintext,
        );
      }

      const setClauses: string[] = [];
      const params: unknown[] = [];
      let i = 1;

      if (updates.access_token_encrypted) {
        setClauses.push(`access_token_encrypted = $${i++}`);
        params.push(updates.access_token_encrypted);
      }
      if (updates.refresh_token_encrypted) {
        setClauses.push(`refresh_token_encrypted = $${i++}`);
        params.push(updates.refresh_token_encrypted);
      }

      if (setClauses.length > 0) {
        params.push(row.id);
        await client.query(
          `UPDATE provider_admins SET ${setClauses.join(', ')} WHERE id = $${i}`,
          params,
        );
        migrated++;
        console.log(`  migrated ${row.id}`);
      }
    }

    console.log(`\nDone: ${migrated} migrated, ${skipped} already encrypted, ${rows.length} total`);
  } finally {
    await client.end();
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
