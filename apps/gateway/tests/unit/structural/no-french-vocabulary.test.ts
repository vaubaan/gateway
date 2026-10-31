/**
 * Structural test (owner decision of 2026-10-31, ADR
 * macro-actions-and-trust-levels-prefill-the-policy, History): the repository
 * speaks English. The French words of the first version of the trust levels —
 * the level itself, its tier and the three level names — are gone from the
 * code, the catalogs, the documents and the website, and must not come back.
 *
 * The scan reads every text file git tracks, whole words, any case.
 * The only files allowed to keep the old words are the ones that record
 * history, each with its reason below.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const SELF = relative(REPO, fileURLToPath(import.meta.url));

/** Built from parts so that this file does not hold the words it forbids. */
const RETIRED = ['cr' + 'an', 'cr' + 'ans', 'pal' + 'ier', 'pal' + 'iers', 'prud' + 'ent'];
const RETIRED_LEVELS = ['confi' + 'ant', 'auto' + 'nome'];
const FORBIDDEN = new RegExp(`\\b(?:${[...RETIRED, ...RETIRED_LEVELS].join('|')})\\b`, 'i');

const ADR = 'docs/decisions/macro-actions-and-trust-levels-prefill-the-policy.md';

/** Files that record history, allowed to name the old words, with the reason. */
const ALLOWED: Record<string, string> = {
  'CHANGELOG.md':
    'released entries are history, and the upgrade note names the field agents used to send',
  'apps/gateway/migrations/0025_mission_connection_crans.sql':
    'an applied migration is checksummed: its text never changes',
};

const TEXT = /\.(ts|tsx|js|mjs|cjs|json|md|mdx|ya?ml|sql|css|html|sh|txt|toml)$/;

/** The files of the repository: what git tracks, so nothing generated or ignored. */
function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files', '-z'], { cwd: REPO, encoding: 'utf8' })
    .split('\0')
    .filter((f) => TEXT.test(f) && !f.endsWith('package-lock.json'));
}

/** The ADR may name the old words in its History section only. */
function scannedText(file: string): string {
  const text = readFileSync(resolve(REPO, file), 'utf8');
  if (file !== ADR) return text;
  const history = text.indexOf('\n## History');
  return history < 0 ? text : text.slice(0, history);
}

describe('structural: no French vocabulary left in the repository', () => {
  const scanned = trackedFiles().filter((f) => f !== SELF && !(f in ALLOWED));

  it('scans a meaningful set of files', () => {
    expect(scanned.length).toBeGreaterThan(500);
    expect(scanned).toEqual(
      expect.arrayContaining([
        'README.md',
        ADR,
        'docs/spec/gateway-risk-model.md',
        'packages/policy-engine/src/trust-level.ts',
        'plugins/github/src/risk-catalog.yaml',
        'apps/gateway/src/lib/vocabulary.ts',
      ]),
    );
  });

  it('every allowed file still exists and still needs its exemption', () => {
    for (const file of Object.keys(ALLOWED)) {
      expect(FORBIDDEN.test(readFileSync(resolve(REPO, file), 'utf8')), file).toBe(true);
    }
  });

  it('no scanned file names a trust level, a tier or a level in French', () => {
    const hits = scanned.flatMap((file) =>
      scannedText(file)
        .split('\n')
        .flatMap((line, i) => (FORBIDDEN.test(line) ? [`${file}:${i + 1}: ${line.trim()}`] : [])),
    );
    expect(hits).toEqual([]);
  });
});
