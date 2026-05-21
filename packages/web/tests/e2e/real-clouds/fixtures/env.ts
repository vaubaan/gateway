/**
 * E2E env loader — loads `.env.test` from the repo root and exposes
 * a strongly-typed view of the credentials. Spec §12.3.
 *
 * Posture "no mock" : every E2E scenario hits a real provider with
 * the creds resolved here. `.env.test` is gitignored and lives only
 * on the operator's machine + (mirrored) on GitHub Actions secrets
 * (cf. `.github/workflows/e2e-nightly.yml`).
 *
 * Two contexts feed this loader:
 *  - Local dev: `.env.test` at the repo root.
 *  - GitHub Actions: env vars injected from the workflow (no file).
 *
 * The loader tolerates either path: if `.env.test` is missing but the
 * env vars are present in `process.env`, it's fine.
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface E2EEnv {
  readonly supabaseUrl: string;
  readonly supabaseAnonKey: string;
  readonly supabaseServiceRoleKey: string;
  readonly orgEmail: string;
  readonly github: {
    readonly org: string;
    readonly adminToken: string;
  };
  readonly vercel: {
    readonly teamId: string;
    readonly teamToken: string;
  };
  readonly supabaseMgmt: {
    readonly orgSlug: string;
    readonly token: string;
  };
  readonly infisical: {
    readonly url: string;
    readonly login: string;
    readonly pwd: string;
  };
  readonly baseUrl: string;
}

function loadDotenvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(path)) return out;
  const txt = readFileSync(path, 'utf8');
  for (const rawLine of txt.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

let cached: E2EEnv | null = null;

function repoRoot(): string {
  // tests/e2e/real-clouds/fixtures/env.ts → up 5 levels → repo root.
  return resolve(__dirname, '../../../../../..');
}

/**
 * Resolve a single env var by walking, in order:
 *  1. `process.env[key]`
 *  2. `.env.test` (repo root)
 *  3. fallback aliases (for GH Actions secret names which can't
 *     start with GITHUB_ — they are renamed `VAUBAN_E2E_GH_*`).
 */
function readEnv(
  raw: Record<string, string>,
  key: string,
  fallbacks: readonly string[] = [],
): string | undefined {
  for (const k of [key, ...fallbacks]) {
    const fromProcess = process.env[k];
    if (fromProcess !== undefined && fromProcess !== '') return fromProcess;
    const fromFile = raw[k];
    if (fromFile !== undefined && fromFile !== '') return fromFile;
  }
  return undefined;
}

function requireEnv(
  raw: Record<string, string>,
  key: string,
  fallbacks: readonly string[] = [],
): string {
  const v = readEnv(raw, key, fallbacks);
  if (v === undefined) {
    const aliases = fallbacks.length > 0 ? ` (or ${fallbacks.join(', ')})` : '';
    throw new Error(
      `Missing E2E env var: ${key}${aliases}. ` +
        `Populate .env.test at the repo root (cf. docs/handbook/e2e-testing.md) ` +
        `or export the var in the calling shell / GH Actions workflow.`,
    );
  }
  return v;
}

export function loadE2EEnv(): E2EEnv {
  if (cached !== null) return cached;
  const raw = loadDotenvFile(resolve(repoRoot(), '.env.test'));

  // Supabase web app creds — these can also come from the standard
  // packages/web/.env.local in local dev (so `npm run dev` works).
  const webLocal = loadDotenvFile(resolve(repoRoot(), 'packages/web/.env.local'));
  for (const [k, v] of Object.entries(webLocal)) {
    if (raw[k] === undefined) raw[k] = v;
  }

  cached = {
    supabaseUrl: requireEnv(raw, 'NEXT_PUBLIC_SUPABASE_URL', ['SUPABASE_URL']),
    supabaseAnonKey: requireEnv(raw, 'NEXT_PUBLIC_SUPABASE_ANON_KEY', ['SUPABASE_ANON_KEY']),
    supabaseServiceRoleKey: requireEnv(raw, 'SUPABASE_SERVICE_ROLE_KEY'),
    orgEmail: requireEnv(raw, 'ORG_EMAIL'),
    github: {
      org: requireEnv(raw, 'GITHUB_ORG', ['VAUBAN_E2E_GH_ORG']),
      adminToken: requireEnv(raw, 'GITHUB_ORG_ADMIN_TOKEN', ['VAUBAN_E2E_GH_ADMIN_TOKEN']),
    },
    vercel: {
      teamId: requireEnv(raw, 'VERCEL_TEAM_ID', ['VAUBAN_E2E_VERCEL_TEAM_ID']),
      teamToken: requireEnv(raw, 'VERCEL_TEAM_TOKEN', ['VAUBAN_E2E_VERCEL_TEAM_TOKEN']),
    },
    supabaseMgmt: {
      orgSlug: requireEnv(raw, 'SUPABASE_ORG_SLUG', ['VAUBAN_E2E_SUPABASE_ORG_SLUG']),
      token: requireEnv(raw, 'SUPABASE_TOKEN', ['VAUBAN_E2E_SUPABASE_TOKEN']),
    },
    infisical: {
      url: requireEnv(raw, 'INFISICAL_URL', ['VAUBAN_E2E_INFISICAL_URL']),
      login: requireEnv(raw, 'INFISICAL_LOGIN', ['VAUBAN_E2E_INFISICAL_LOGIN']),
      pwd: requireEnv(raw, 'INFISICAL_PWD', ['VAUBAN_E2E_INFISICAL_PWD']),
    },
    baseUrl: readEnv(raw, 'E2E_BASE_URL') ?? 'http://localhost:3000',
  };
  return cached;
}

/**
 * `hasE2EEnv` — non-throwing variant used by smoke tests that want
 * to `test.skip()` cleanly when creds are missing (typical CI scenario
 * on PRs where the E2E secrets are not exposed).
 */
export function hasE2EEnv(): boolean {
  try {
    loadE2EEnv();
    return true;
  } catch {
    return false;
  }
}
