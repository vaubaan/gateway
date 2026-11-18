#!/usr/bin/env node
// Refreshes the Sigstore trusted root the gateway embeds (ADR
// plugin-signature-sets-the-trust-level): the keys and certificates against which a
// catalog archive's signature is verified, offline, at every upload and start.
//
//   node scripts/fetch-sigstore-root.mjs [--check]
//
// Reads `trusted_root.json` from Sigstore's public TUF repository, walked from the root
// `@sigstore/tuf` embeds (each TUF step signed by the previous one), and writes it to
// apps/gateway/src/server/plugins/sigstore-trusted-root.json. `--check` writes nothing and
// exits 1 when the embedded file differs from what TUF serves now: run before a release, a
// difference means Sigstore added a key the shipped gateway does not know yet.
//
// The gateway itself never calls TUF: a root a gateway shipped with keeps verifying the
// signatures made with the keys it holds (their validity windows are in the file).
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TrustedRoot } from '@sigstore/protobuf-specs';
import { getTrustedRoot } from '@sigstore/tuf';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const EMBEDDED = join(ROOT, 'apps/gateway/src/server/plugins/sigstore-trusted-root.json');

async function main() {
  const cache = mkdtempSync(join(tmpdir(), 'vaubaan-tuf-'));
  try {
    const trustedRoot = await getTrustedRoot({ cachePath: cache });
    // The protobuf JSON form (base64 bytes), the one `TrustedRoot.fromJSON` reads back.
    const text = `${JSON.stringify(TrustedRoot.toJSON(trustedRoot), null, 2)}\n`;
    if (process.argv.includes('--check')) {
      const current = readFileSync(EMBEDDED, 'utf8');
      if (current !== text) {
        console.error(`${EMBEDDED} differs from the trusted root Sigstore serves: refresh it`);
        process.exitCode = 1;
        return;
      }
      console.log('the embedded Sigstore trusted root is current');
      return;
    }
    writeFileSync(EMBEDDED, text);
    console.log(`wrote ${EMBEDDED}`);
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
