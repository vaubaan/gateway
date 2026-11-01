/**
 * Test fixtures for the configuration loader and everything built on it.
 * Values are deliberately fake (RFC 2606 domains, random keys at import).
 */
import { randomBytes } from 'node:crypto';

import { MASTER_KEY_BYTES } from '../../../src/server/config/load';

export const TEST_MASTER_KEY = randomBytes(MASTER_KEY_BYTES).toString('base64');
export const TEST_BOOTSTRAP_TOKEN = 'bootstrap-' + randomBytes(24).toString('hex');

/** The smallest environment that loads: no IdP, bootstrap token present. */
export function validEnv(
  overrides: Record<string, string | undefined> = {},
): Record<string, string> {
  const base: Record<string, string> = {
    VAUBAAN_PUBLIC_URL: 'https://gateway.example.com',
    VAUBAAN_STORE_PATH: '/tmp/vaubaan-test/gateway.db',
    VAUBAAN_MASTER_KEY: TEST_MASTER_KEY,
    VAUBAAN_ADMIN_EMAILS: 'ops@example.com',
    VAUBAAN_BOOTSTRAP_TOKEN: TEST_BOOTSTRAP_TOKEN,
  };
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete base[k];
    else base[k] = v;
  }
  return base;
}

/** An in-memory file system for `readFile` injection. */
export function fakeFiles(files: Record<string, string>): (path: string) => string {
  return (path) => {
    const content = files[path];
    if (content === undefined) {
      throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), {
        code: 'ENOENT',
      });
    }
    return content;
  };
}
