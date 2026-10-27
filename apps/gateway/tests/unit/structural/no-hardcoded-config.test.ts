/**
 * Structural test (spec §10 "no configuration value is hard-coded").
 *
 * Scans the v5 server code and the deployment files for literal URLs,
 * secrets and project references. The only allowed literal URL is the
 * telemetry collector default in `telemetry-default.ts`; example files under
 * `deploy/config/*.example*` may show placeholders.
 *
 * Scope: the whole application (`apps/gateway/src`, `next.config.ts`), `deploy/`,
 * `scripts/` and `.github/workflows`. The v4 UI and `lib/`, which the scan used
 * to leave out, were deleted with the v4 application.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');

const SCANNED = [
  'apps/gateway/src',
  'apps/gateway/next.config.ts',
  'deploy',
  'scripts',
  '.github/workflows',
];

/** Files allowed to contain what the scan forbids, with the reason. */
const ALLOWED: Record<string, string> = {
  'apps/gateway/src/server/config/telemetry-default.ts': 'the single default URL (spec §4.3)',
  'deploy/collector/README.md': 'the collector documents its own public host (the default URL)',
  'apps/gateway/src/server/config/sign-in.ts':
    'public sign-in providers by address: github.com, and the issuers anyone can hold an account at (ADR sign-in-providers-admission-and-admin-rule)',
  'apps/gateway/src/server/connections/attestation-gcp.ts':
    "Google Cloud Attestation's issuer, the fixed root of trust a broker's Confidential Space attestation is checked against (ADR oauth-broker-stateless-in-an-attested-enclave D4, D7)",
  'deploy/config/gateway.example.yaml': 'documented placeholders',
  'deploy/config/.env.example': 'documented placeholders',
  'scripts/fetch-tool.sh':
    'the release archives of the pinned security tools, each checked against its SHA-256 before it runs',
  'scripts/lockfile-gate.mjs':
    'the one registry a lockfile entry may download from: the rule the gate enforces',
  'scripts/lockfile-gate.test.mjs': 'tarball URLs, allowed and refused, of the lockfile gate tests',
};

const TEST_FILE = /\.test\.tsx?$|\/testing\.ts$/;
const SOURCE =
  /\.(ts|tsx|mjs|js|json|ya?ml|sh|md|Dockerfile|Caddyfile)$|\/Dockerfile$|\/Caddyfile$/;

const FORBIDDEN: Array<{ name: string; pattern: RegExp }> = [
  // Any literal URL with a real-looking host. Hosts reserved for documentation
  // (example.com/net/org, localhost, 127.0.0.1, 0.0.0.0) and schema/spec
  // registries used by tooling are fine, and so is GitHub Actions' OIDC
  // issuer, the fixed identity an operator checks a release signature against.
  {
    name: 'literal URL',
    pattern:
      /https?:\/\/(?!(?:[a-z0-9-]+\.)*example\.(?:com|net|org)\b|localhost\b|127\.0\.0\.1\b|0\.0\.0\.0\b|\[::1\]|json\.schemastore\.org|docs\.docker\.com|token\.actions\.githubusercontent\.com\b|github\.com\/[a-z-]+\/[a-z-]+\/(?:blob|tree|issues|discussions)|ghcr\.io\/\$\{)[a-z0-9.-]+\.[a-z]{2,}(?::\d+)?(?:\/|\b)/i,
  },
  { name: 'Supabase project ref URL', pattern: /[a-z]{20}\.supabase\.co/ },
  { name: 'GitHub token', pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/ },
  { name: 'mission token secret', pattern: /vbn_(?:live|test)_[A-Za-z0-9]{8}_[A-Za-z0-9]{32}/ },
  { name: 'private key block', pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: 'JWT', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./ },
  { name: 'Stripe key', pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/ },
];

function walk(path: string, out: string[]): void {
  const stat = statSync(path, { throwIfNoEntry: false });
  if (!stat) return;
  if (stat.isFile()) {
    out.push(path);
    return;
  }
  for (const entry of readdirSync(path)) {
    if (entry === 'node_modules' || entry === '.next') continue;
    walk(join(path, entry), out);
  }
}

describe('structural: no hard-coded configuration in the v5 perimeter', () => {
  const files: string[] = [];
  for (const root of SCANNED) walk(resolve(REPO, root), files);
  const candidates = files
    .map((f) => relative(REPO, f))
    .filter((f) => SOURCE.test(f) && !TEST_FILE.test(f) && !(f in ALLOWED));

  it('scans a meaningful set of files', () => {
    expect(candidates.length).toBeGreaterThan(10);
    expect(candidates).toContain('apps/gateway/src/server/config/load.ts');
    expect(candidates).toContain('deploy/docker/Dockerfile');
  });

  for (const file of candidates) {
    it(file, () => {
      const text = readFileSync(resolve(REPO, file), 'utf8');
      const hits = FORBIDDEN.flatMap(({ name, pattern }) => {
        const m = pattern.exec(text);
        return m ? [`${name}: ${m[0]}`] : [];
      });
      expect(hits, `${file} contains a hard-coded value`).toEqual([]);
    });
  }

  it('allows the telemetry default URL only in telemetry-default.ts', () => {
    const text = readFileSync(
      resolve(REPO, 'apps/gateway/src/server/config/telemetry-default.ts'),
      'utf8',
    );
    expect(text.match(/https:\/\//g)?.length).toBe(1);
  });
});
