/**
 * Structural test (spec §10 "no configuration value is hard-coded").
 *
 * Scans the v5 server code and the deployment files for literal URLs,
 * secrets and project references. The only allowed literal URLs are the
 * telemetry collector default in `telemetry-default.ts`, the versions feed
 * default in `updates-default.ts` and the docs default in `docs-default.ts`;
 * example files under
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
  'apps/gateway/src/server/config/updates-default.ts':
    'the default of updates.feed_url, the published versions feed (spec §4.3)',
  'apps/gateway/src/server/config/docs-default.ts':
    'the default of docs.url, the user docs the interface links to',
  'deploy/collector/README.md': 'the collector documents its own public host (the default URL)',
  'deploy/README.md': 'points its readers to the procedures published on the documentation site',
  'deploy/railway.md':
    'points its readers to the Railway procedure published on the documentation site',
  'apps/gateway/src/server/config/sign-in.ts':
    'public sign-in providers by address: github.com, and the issuers anyone can hold an account at (docs/handbook/authentication.md)',
  'apps/gateway/src/server/accounts/attestation-gcp.ts':
    "Google Cloud Attestation's issuer, the fixed root of trust a broker's Confidential Space attestation is checked against (ADR oauth-broker-stateless-in-an-attested-enclave D4, D7)",
  'apps/gateway/src/server/notifications/messaging/messages.ts':
    'the `$schema` identifier of an Adaptive Card, a name inside the Teams message format, never fetched',
  'scripts/fetch-socle.mjs':
    'where the catalog publishes its signed archives, read at image build; each archive pinned by its sha256 in deploy/socle.json',
  'scripts/release-prepare.mjs':
    "the catalog index's published address, read at a gateway release to write catalog-versions.json; --catalog-index reads another",
  'apps/gateway/src/server/plugins/catalog.ts':
    "where the catalog publishes its signed archives, like the versions feed's address: public, read without credentials, and nothing it serves is trusted before its signature verifies",
  'apps/gateway/src/server/plugins/trust.ts':
    'the identity that signs "Vaubaan": the catalog release workflow and GitHub\'s OIDC issuer, a fixed root of trust like an attestation issuer (ADR plugin-signature-sets-the-trust-level)',
  'apps/gateway/src/server/plugins/sigstore-trusted-root.json':
    "Sigstore's trusted root: the logs and authorities a signature is checked against, offline, never fetched; refreshed by scripts/fetch-sigstore-root.mjs",
  'scripts/check-changed.mjs':
    "the public repository of Semgrep's community rules, cloned at the commit ci.yml pins, as CI does",
  '.github/workflows/publish-plugin-kit.yml':
    'the npm registry the plugin kit is published to (setup-node registry-url, trusted publishing)',
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

  it('allows the docs default URL only in docs-default.ts', () => {
    const text = readFileSync(
      resolve(REPO, 'apps/gateway/src/server/config/docs-default.ts'),
      'utf8',
    );
    expect(text.match(/https:\/\//g)?.length).toBe(1);
  });

  it('allows the versions feed default URL only in updates-default.ts', () => {
    const text = readFileSync(
      resolve(REPO, 'apps/gateway/src/server/config/updates-default.ts'),
      'utf8',
    );
    expect(text.match(/https:\/\//g)?.length).toBe(1);
  });
});
