/**
 * Structural test: nothing secret leaves the operator's machine with a build.
 *
 * `.dockerignore` keeps secrets out of the image's build context; `.railwayignore`
 * keeps them out of what `railway up` uploads to Railway's builder when it is run
 * from a working tree (security review 2026-10-15, secrets-and-infra M5). Both must
 * name every secret-bearing path an operator's checkout can hold: env files, keys,
 * the mounted YAML configuration, the agent and operator tooling directories.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');

function patterns(file: string): Set<string> {
  return new Set(
    readFileSync(resolve(REPO, file), 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'))
      // `.claude` and `.claude/` exclude the same directory.
      .map((line) => line.replace(/\/$/, '')),
  );
}

/** What both files must exclude. */
const SECRET_PATTERNS = [
  '**/.env',
  '**/.env.*',
  '!**/.env.example',
  '**/*.pem',
  '**/*.key',
  '**/id_rsa*',
  '**/id_ed25519*',
  '**/id_ecdsa*',
  'deploy/config/gateway.yaml',
  '.mcp.json',
  '.vaubaan',
  '.claude',
  '.codex',
  '.opencode',
  '.agents',
  '.git',
];

describe('build uploads exclude every secret-bearing path', () => {
  it.each(['.dockerignore', '.railwayignore'])('%s', (file) => {
    const present = patterns(file);
    expect(SECRET_PATTERNS.filter((p) => !present.has(p))).toEqual([]);
  });

  it('.railwayignore excludes the root env files explicitly too', () => {
    const present = patterns('.railwayignore');
    expect(['.env', '.env.*', '*.pem'].filter((p) => !present.has(p))).toEqual([]);
  });
});
