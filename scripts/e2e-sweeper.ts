/**
 * E2E sweeper — best-effort cleanup of orphaned `vauban-e2e-*` resources.
 *
 * Goal : if a Playwright spec crashes between `create` and `destroy`,
 * the test resource lingers on the provider. The sweeper runs nightly
 * (cf. `.github/workflows/e2e-nightly.yml`), lists everything matching
 * the `vauban-e2e-…` prefix on each provider, and deletes anything
 * older than 24h.
 *
 * Posture :
 *   - Strict prefix match → no risk of touching prod resources.
 *   - Age filter (>24h) → never delete a still-running run's resources.
 *   - `--dry-run` (default in CI safety mode) lists without acting.
 *   - Reports per-provider stats. If > 5 orphans / provider, exits
 *     non-zero so the nightly workflow can alert.
 *
 * Spec §12.3 "Sweeper (cron CI nightly)".
 *
 * Run via:
 *   npm run sweeper          (live mode)
 *   npm run sweeper -- --dry-run
 */

import { loadE2EEnv } from '../packages/web/tests/e2e/real-clouds/fixtures/env';
import { GithubClient } from '../packages/web/tests/e2e/real-clouds/fixtures/provider-clients/github';
import { VercelClient } from '../packages/web/tests/e2e/real-clouds/fixtures/provider-clients/vercel';
import { SupabaseMgmtClient } from '../packages/web/tests/e2e/real-clouds/fixtures/provider-clients/supabase';
import { InfisicalClient } from '../packages/web/tests/e2e/real-clouds/fixtures/provider-clients/infisical';
import { makeAdminClient } from '../packages/web/tests/e2e/real-clouds/fixtures/vauban-client';

interface SweeperOpts {
  readonly dryRun: boolean;
  readonly maxAgeHours: number;
  readonly alertThreshold: number;
}

interface ProviderStat {
  readonly provider: string;
  readonly listed: number;
  readonly destroyed: number;
  readonly skippedTooYoung: number;
  readonly errors: readonly string[];
}

function parseArgs(): SweeperOpts {
  const dryRun = process.argv.includes('--dry-run');
  const maxAgeHoursIdx = process.argv.indexOf('--max-age-hours');
  const maxAgeHours =
    maxAgeHoursIdx > -1 ? Number.parseInt(process.argv[maxAgeHoursIdx + 1] ?? '24', 10) : 24;
  return {
    dryRun,
    maxAgeHours: Number.isFinite(maxAgeHours) ? maxAgeHours : 24,
    alertThreshold: 5,
  };
}

function isOld(createdAtMs: number, maxAgeHours: number): boolean {
  const ageMs = Date.now() - createdAtMs;
  return ageMs > maxAgeHours * 3600 * 1000;
}

async function sweepGithub(client: GithubClient, opts: SweeperOpts): Promise<ProviderStat> {
  const errors: string[] = [];
  let destroyed = 0;
  let skipped = 0;
  let repos: Awaited<ReturnType<GithubClient['listE2ERepos']>> = [];
  try {
    repos = await client.listE2ERepos();
  } catch (e) {
    errors.push(String(e));
    return { provider: 'github', listed: 0, destroyed: 0, skippedTooYoung: 0, errors };
  }
  for (const r of repos) {
    const created = new Date(r.created_at).getTime();
    if (!isOld(created, opts.maxAgeHours)) {
      skipped += 1;
      continue;
    }
    if (opts.dryRun) {
      console.log(`[dry-run] DELETE github repo ${r.full_name} (created ${r.created_at})`);
      destroyed += 1;
      continue;
    }
    try {
      await client.deleteRepo(r.name);
      destroyed += 1;
      console.log(`destroyed github repo ${r.full_name}`);
    } catch (e) {
      errors.push(`${r.full_name}: ${String(e)}`);
    }
  }
  return { provider: 'github', listed: repos.length, destroyed, skippedTooYoung: skipped, errors };
}

async function sweepVercel(client: VercelClient, opts: SweeperOpts): Promise<ProviderStat> {
  const errors: string[] = [];
  let destroyed = 0;
  let skipped = 0;
  let projects: Awaited<ReturnType<VercelClient['listE2EProjects']>> = [];
  try {
    projects = await client.listE2EProjects();
  } catch (e) {
    errors.push(String(e));
    return { provider: 'vercel', listed: 0, destroyed: 0, skippedTooYoung: 0, errors };
  }
  for (const p of projects) {
    if (!isOld(p.createdAt, opts.maxAgeHours)) {
      skipped += 1;
      continue;
    }
    if (opts.dryRun) {
      console.log(
        `[dry-run] DELETE vercel project ${p.name} (created ${new Date(p.createdAt).toISOString()})`,
      );
      destroyed += 1;
      continue;
    }
    try {
      await client.deleteProject(p.id);
      destroyed += 1;
      console.log(`destroyed vercel project ${p.name}`);
    } catch (e) {
      errors.push(`${p.name}: ${String(e)}`);
    }
  }
  return {
    provider: 'vercel',
    listed: projects.length,
    destroyed,
    skippedTooYoung: skipped,
    errors,
  };
}

async function sweepSupabase(client: SupabaseMgmtClient, opts: SweeperOpts): Promise<ProviderStat> {
  const errors: string[] = [];
  let destroyed = 0;
  let skipped = 0;
  let projects: Awaited<ReturnType<SupabaseMgmtClient['listE2EProjects']>> = [];
  try {
    projects = await client.listE2EProjects();
  } catch (e) {
    errors.push(String(e));
    return { provider: 'supabase', listed: 0, destroyed: 0, skippedTooYoung: 0, errors };
  }
  for (const p of projects) {
    const created = new Date(p.created_at).getTime();
    if (!isOld(created, opts.maxAgeHours)) {
      skipped += 1;
      continue;
    }
    if (opts.dryRun) {
      console.log(
        `[dry-run] DELETE supabase project ${p.name} ref=${p.id} (created ${p.created_at})`,
      );
      destroyed += 1;
      continue;
    }
    try {
      await client.deleteProject(p.id);
      destroyed += 1;
      console.log(`destroyed supabase project ${p.name} ref=${p.id}`);
    } catch (e) {
      errors.push(`${p.name}: ${String(e)}`);
    }
  }
  return {
    provider: 'supabase',
    listed: projects.length,
    destroyed,
    skippedTooYoung: skipped,
    errors,
  };
}

async function sweepInfisical(client: InfisicalClient): Promise<ProviderStat> {
  const errors: string[] = [];
  try {
    await client.ping();
  } catch (e) {
    errors.push(String(e));
    return { provider: 'infisical', listed: 0, destroyed: 0, skippedTooYoung: 0, errors };
  }
  // No transient secrets created by Phase 8 scenarios — placeholder.
  return { provider: 'infisical', listed: 0, destroyed: 0, skippedTooYoung: 0, errors: [] };
}

async function sweepSupabaseAuth(opts: SweeperOpts): Promise<ProviderStat> {
  const errors: string[] = [];
  let destroyed = 0;
  let skipped = 0;
  const admin = makeAdminClient();
  let users: Awaited<ReturnType<typeof admin.listE2EUsers>> = [];
  try {
    users = await admin.listE2EUsers();
  } catch (e) {
    errors.push(String(e));
    return { provider: 'supabase-auth', listed: 0, destroyed: 0, skippedTooYoung: 0, errors };
  }
  for (const u of users) {
    const created = new Date(u.createdAt).getTime();
    if (!isOld(created, opts.maxAgeHours)) {
      skipped += 1;
      continue;
    }
    if (opts.dryRun) {
      console.log(`[dry-run] DELETE supabase auth user ${u.email}`);
      destroyed += 1;
      continue;
    }
    try {
      await admin.deleteTestUser(u.id);
      destroyed += 1;
      console.log(`destroyed supabase auth user ${u.email}`);
    } catch (e) {
      errors.push(`${u.email}: ${String(e)}`);
    }
  }
  return {
    provider: 'supabase-auth',
    listed: users.length,
    destroyed,
    skippedTooYoung: skipped,
    errors,
  };
}

async function main(): Promise<void> {
  const opts = parseArgs();
  console.log(`vauban-e2e sweeper — dryRun=${String(opts.dryRun)} maxAgeHours=${opts.maxAgeHours}`);

  const env = loadE2EEnv();
  const stats: ProviderStat[] = [];

  stats.push(await sweepGithub(new GithubClient(env.github.adminToken, env.github.org), opts));
  stats.push(await sweepVercel(new VercelClient(env.vercel.teamToken, env.vercel.teamId), opts));
  stats.push(
    await sweepSupabase(
      new SupabaseMgmtClient(env.supabaseMgmt.token, env.supabaseMgmt.orgSlug),
      opts,
    ),
  );
  stats.push(
    await sweepInfisical(
      new InfisicalClient(env.infisical.url, env.infisical.login, env.infisical.pwd),
    ),
  );
  stats.push(await sweepSupabaseAuth(opts));

  console.log('\n--- Sweeper report ---');
  let totalOrphans = 0;
  let totalErrors = 0;
  for (const s of stats) {
    console.log(
      `  ${s.provider.padEnd(16)} listed=${s.listed} destroyed=${s.destroyed} skipped<24h=${s.skippedTooYoung} errors=${s.errors.length}`,
    );
    totalOrphans += s.destroyed;
    totalErrors += s.errors.length;
    for (const err of s.errors) {
      console.log(`    err: ${err}`);
    }
  }

  // Sweeper exit code policy: les "errors" par provider sont des
  // problèmes de config (login HTTP 404, token expiré, etc.) — c'est
  // un signal pour l'opérateur mais pas un fail bloquant tant qu'au
  // moins un provider a pu s'exécuter sans erreur. Le vrai signal de
  // crash E2E est totalOrphans > threshold (cf. spec §12.3 "sweeper
  // alerte sur Telegram si > N orphelins").
  const okProviders = stats.filter((s) => s.errors.length === 0).length;
  if (okProviders === 0) {
    console.error('\nsweeper: 0 providers swept cleanly — credential setup likely broken');
    process.exit(2);
  }
  if (totalOrphans > opts.alertThreshold) {
    console.error(
      `\nsweeper destroyed ${totalOrphans} orphans (threshold=${opts.alertThreshold}) — investigate E2E crashes`,
    );
    process.exit(3);
  }
  if (totalErrors > 0) {
    console.warn(`\nsweeper completed with ${totalErrors} provider error(s) — review above`);
  }
  console.log('\nsweeper OK');
}

main().catch((e: unknown) => {
  console.error('sweeper fatal:', e);
  process.exit(1);
});
