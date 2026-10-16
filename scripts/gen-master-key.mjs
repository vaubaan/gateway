#!/usr/bin/env node
/**
 * Prints a fresh master key for `encryption.master_key` / VAUBAAN_MASTER_KEY:
 * 32 random bytes, base64. Nothing else is written anywhere.
 *
 *   npm run gen-master-key
 *   node scripts/gen-master-key.mjs > /run/secrets/vaubaan_master_key
 */
import { randomBytes } from 'node:crypto';

// Same size as KEY_BYTES in apps/gateway/src/server/crypto/aead.ts (the AEAD key);
// a plain script cannot import the TypeScript constant.
const MASTER_KEY_BYTES = 32;

process.stdout.write(randomBytes(MASTER_KEY_BYTES).toString('base64') + '\n');
