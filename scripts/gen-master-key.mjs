#!/usr/bin/env node
/**
 * Prints a fresh master key for `encryption.master_key` / VAUBAAN_MASTER_KEY:
 * 32 random bytes, base64. Nothing else is written anywhere.
 *
 *   npm run gen-master-key
 *   node scripts/gen-master-key.mjs > /run/secrets/vaubaan_master_key
 */
import { randomBytes } from 'node:crypto';

process.stdout.write(randomBytes(32).toString('base64') + '\n');
