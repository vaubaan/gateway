/**
 * Provider info registry — central place mapping the URL slug
 * (`github`, `vercel`, `supabase`, `railway`, `bash`) to the
 * provider-package exports the info page needs (data-model, available
 * tools list, presentation copy).
 *
 * Spec : docs/spec/gateway-risk-model.md §1, §2.
 * Used by : `/orgs/[slug]/providers/[provider]/page.tsx` and the per-plane
 *           variant `[provider]/[plane]/page.tsx`.
 *
 * Multi-plane note (Supabase) :
 *  - When a provider exposes more than one plane (Supabase has 4 : db /
 *    storage / auth / functions), the info page redirects to a `[plane]`
 *    sub-route so each plane gets its own 5-section page (data-model,
 *    risks, tools, setup — all filtered to that plane).
 *  - Per-plane metadata (label, pitch, optional setup override) lives in
 *    `planes[].info`. Tools and risks are filtered at render time via
 *    helper functions exported from this module.
 */

import type { DataModel, McpToolDeclaration, Provider, RiskEntry } from '@vaubaan/shared';

import { githubAvailableTools, githubDataModel } from '@vaubaan/plugin-github';
import { vercelAvailableTools, vercelDataModel } from '@vaubaan/plugin-vercel';
import {
  supabaseAvailableTools,
  supabaseDataModel,
  supabaseToolPlanes,
} from '@vaubaan/plugin-supabase';
import { railwayAvailableTools, railwayDataModel } from '@vaubaan/plugin-railway';
import { sshAvailableTools, sshDataModel } from '@vaubaan/plugin-ssh';
import { upstashRedisAvailableTools, upstashRedisDataModel } from '@vaubaan/plugin-upstash-redis';
import { gmailAvailableTools, gmailDataModel } from '@vaubaan/plugin-gmail';
import { stripeAvailableTools, stripeDataModel } from '@vaubaan/plugin-stripe';
import { resendAvailableTools, resendDataModel } from '@vaubaan/plugin-resend';
import { cloudflareDnsDataModel } from '@vaubaan/plugin-cloudflare-dns';

/** Per-plane presentation copy. */
export interface PlaneInfo {
  /** Plane slug as it appears in the URL — must match a slug in `dataModel.planes`. */
  readonly slug: string;
  /** Display label for the tab / header. */
  readonly label: string;
  /** Short pitch for the plane (1 line). */
  readonly pitch: string;
  /** When the provider has a plane-specific connection nuance, the setup
   *  string is overridden here. Falls back to `ProviderInfo.setup`. */
  readonly setup?: string;
}

export interface ProviderInfo {
  /** URL slug (`bash` for the SSH provider). */
  readonly slug: Provider;
  /** Display name shown in the page header. */
  readonly label: string;
  /** One-line pitch shown under the header. */
  readonly pitch: string;
  /** Surface category for the breadcrumb / badge. */
  readonly kind: 'cloud' | 'host';
  /** Declarative entity graph (rendered as mermaid). */
  readonly dataModel: DataModel;
  /** Tools the gateway exposes for this provider. */
  readonly tools: ReadonlyArray<McpToolDeclaration>;
  /** Tool-name → plane slug map (only required when `dataModel.planes.length > 1`). */
  readonly toolPlanes?: Readonly<Record<string, string>>;
  /** Per-plane copy (one entry per plane slug). */
  readonly planes: ReadonlyArray<PlaneInfo>;
  /** Short connection / setup paragraph for the page. */
  readonly setup: string;
  /** Path of the canonical risk-catalog source on GitHub (for "View source"). */
  readonly catalogPath: string;
  /** Handbook slug under `docs/handbook/`. */
  readonly handbook: string;
}

export const PROVIDER_INFO: Record<Provider, ProviderInfo> = {
  github: {
    slug: 'github',
    label: 'GitHub',
    pitch:
      'Code hosting plane — repositories, branches, pull requests, workflows, branch-protection, releases, tags.',
    kind: 'cloud',
    dataModel: githubDataModel,
    tools: githubAvailableTools,
    planes: [
      {
        slug: 'repo',
        label: 'Repo',
        pitch:
          'Repository plane — branches, files, PRs, issues, workflows, branch-protection, releases, tags.',
      },
    ],
    setup:
      'Install the Vaubaan Gateway GitHub App on the org or user account that owns the repos you want to expose. Vaubaan mints short-lived installation tokens at runtime — no long-lived PAT is stored.',
    catalogPath: 'plugins/github/src/risk-catalog.yaml',
    handbook: 'docs/handbook/providers/github.md',
  },
  vercel: {
    slug: 'vercel',
    label: 'Vercel',
    pitch:
      'Runtime hosting plane — projects, deployments, env vars, custom domains, deployment-protection (SSO/password), preview comments.',
    kind: 'cloud',
    dataModel: vercelDataModel,
    tools: vercelAvailableTools,
    planes: [
      {
        slug: 'runtime',
        label: 'Runtime',
        pitch:
          'Runtime hosting — projects, deployments, env vars, domains, deployment-protection, toolbar comments.',
      },
    ],
    setup:
      'Install the Vaubaan Marketplace Integration on the team that owns the projects you want to expose. Vaubaan stores the integration access token (refreshable) and proxies tool calls.',
    catalogPath: 'plugins/vercel/src/risk-catalog.yaml',
    handbook: 'docs/handbook/providers/vercel.md',
  },
  supabase: {
    slug: 'supabase',
    label: 'Supabase',
    pitch:
      'Backend plane — Postgres (db / RLS / migrations), Storage (buckets, objects, signed URLs), Auth (GoTrue users / SSO), Edge Functions (Deno + secrets).',
    kind: 'cloud',
    dataModel: supabaseDataModel,
    tools: supabaseAvailableTools,
    toolPlanes: supabaseToolPlanes,
    planes: [
      {
        slug: 'db',
        label: 'Database',
        pitch: 'Postgres — schemas, tables, rows, indexes, RLS policies, migrations ledger.',
      },
      {
        slug: 'storage',
        label: 'Storage',
        pitch: 'S3-like buckets and objects, with signed-URL distribution.',
      },
      {
        slug: 'auth',
        label: 'Auth (GoTrue)',
        pitch: 'Users, SSO/SAML providers, third-party JWT issuers, auth config.',
      },
      {
        slug: 'functions',
        label: 'Edge Functions',
        pitch: 'Deno edge functions, deployments, and project-wide function secrets.',
      },
    ],
    setup:
      'Paste a Supabase Management API personal access token (PAT, `sbp_…`) — Vaubaan never sees the service_role key. Each project_ref the binding pins is reachable; everything else is denied at the runtime layer.',
    catalogPath: 'plugins/supabase/src/risk-catalog.yaml',
    handbook: 'docs/handbook/providers/supabase.md',
  },
  railway: {
    slug: 'railway',
    label: 'Railway',
    pitch:
      'Runtime hosting plane — projects, environments, services, deployments (logs + status), environment variables, the meta-agent tool.',
    kind: 'cloud',
    dataModel: railwayDataModel,
    tools: railwayAvailableTools,
    planes: [
      {
        slug: 'runtime',
        label: 'Runtime',
        pitch: 'Projects, environments, services, deployments, env vars, the meta-agent tool.',
      },
    ],
    setup:
      'Authorize the Vaubaan Gateway Railway app to manage the projects in your workspace. Vaubaan stores the OAuth refresh token and rotates the access token at each call.',
    catalogPath: 'plugins/railway/src/risk-catalog.yaml',
    handbook: 'docs/handbook/providers/railway-ssh.md',
  },
  bash: {
    slug: 'bash',
    label: 'Bash / SSH',
    pitch:
      'Host plane — every tool call is a shell command on a registered SSH host. R/W is decided by a regex whitelist on the command string.',
    kind: 'host',
    dataModel: sshDataModel,
    tools: sshAvailableTools,
    planes: [
      {
        slug: 'host',
        label: 'Host',
        pitch:
          'A single SSH host with a per-binding annotated bash script — each function = one MCP tool.',
      },
    ],
    setup:
      'Bash bindings live per-project (not org-level). Each binding pairs an annotated bash script with one or more SSH hosts. Hosts are registered via the `ssh_binding` form; commands are dispatched through `ssh__exec`.',
    catalogPath: 'plugins/ssh/src/risk-catalog.yaml',
    handbook: 'docs/handbook/providers/railway-ssh.md',
  },
  ssh: {
    slug: 'ssh',
    label: 'SSH',
    pitch:
      'Standalone SSH host binding — direct command execution on a registered server via ssh__exec.',
    kind: 'host',
    dataModel: sshDataModel,
    tools: sshAvailableTools,
    planes: [
      {
        slug: 'host',
        label: 'Host',
        pitch: 'A standalone SSH host — commands dispatched through ssh__exec.',
      },
    ],
    setup:
      'SSH bindings live per-project. Each binding registers a single host (address, port, user, key). Commands are dispatched through the ssh__exec tool.',
    catalogPath: 'plugins/ssh/src/risk-catalog.yaml',
    handbook: 'docs/handbook/providers/railway-ssh.md',
  },
  'upstash-redis': {
    slug: 'upstash-redis',
    label: 'Upstash Redis',
    pitch:
      'Cache plane — serverless Redis databases (Management API CRUD) and key-value data operations (Data API via REST).',
    kind: 'cloud',
    dataModel: upstashRedisDataModel,
    tools: upstashRedisAvailableTools,
    planes: [
      {
        slug: 'cache',
        label: 'Cache',
        pitch:
          'Serverless Redis — databases, key-value data (strings, hashes, lists, sets), usage statistics.',
      },
    ],
    setup:
      'Paste your Upstash email and Management API key concatenated as `email:api_key`. Vaubaan stores the credential encrypted and uses Basic Auth for the Management API. Per-database REST tokens are fetched at runtime.',
    catalogPath: 'plugins/upstash-redis/src/risk-catalog.yaml',
    handbook: 'docs/handbook/providers/upstash-redis.md',
  },
  gmail: {
    slug: 'gmail',
    label: 'Gmail',
    pitch:
      'Mailbox plane — read threads / messages / labels / drafts via Google’s official MCP server, classified by sender / recipient identity zones (automated / internal / known-external / unknown).',
    kind: 'cloud',
    dataModel: gmailDataModel,
    tools: gmailAvailableTools,
    planes: [
      {
        slug: 'mailbox',
        label: 'Mailbox',
        pitch:
          'A single Gmail account — labels, threads, messages, drafts. Synthetic from-zone / to-zone / bulk-marker / sensitive-label markers gate access by identity rather than containment.',
      },
    ],
    setup:
      'Connect a Gmail account via OAuth (scopes `gmail.readonly` + `gmail.compose`). Configure per-binding `internal_domains`, `allowlist_addresses`, `allowlist_domains`, and `sensitive_labels` to drive the identity-zone classification.',
    catalogPath: 'plugins/gmail/src/risk-catalog.yaml',
    handbook: 'docs/handbook/providers/gmail.md',
  },
  stripe: {
    slug: 'stripe',
    label: 'Stripe',
    pitch:
      'Billing plane — products, prices, coupons, customers, subscriptions, invoices, payments, refunds, webhook endpoints. The `mode` calque (test/live) gates risks per binding via the API-key namespace.',
    kind: 'cloud',
    dataModel: stripeDataModel,
    tools: stripeAvailableTools,
    planes: [
      {
        slug: 'billing',
        label: 'Billing',
        pitch:
          'A single Stripe account (one API key = one mode = test or live) — catalog, customers, subscriptions, invoices, payment intents, refunds, monitoring, webhooks. Refund-create carries cardinal caps (cost: unbounded, irreversible).',
      },
    ],
    setup:
      'Paste a Stripe restricted API key (`sk_test_*` for test, `sk_live_*` for live) — Vaubaan stores it encrypted and the binding pins the mode. The classifier reads `environment` on the binding (`live` | `test`) and qualifies cardinal risks as `stripe[live].refund-create` etc.',
    catalogPath: 'plugins/stripe/src/risk-catalog.yaml',
    handbook: 'docs/handbook/providers/stripe.md',
  },
  resend: {
    slug: 'resend',
    label: 'Resend',
    pitch:
      'Email plane — transactional emails, batch sends, audiences, contacts, broadcasts. Identity-zoning (to-zone) gates recipients by internal/allowlist/external classification.',
    kind: 'cloud',
    dataModel: resendDataModel,
    tools: resendAvailableTools,
    planes: [
      {
        slug: 'email',
        label: 'Email',
        pitch:
          'A single Resend account (one API key) — transactional emails, batch sends, audiences, contacts, broadcasts, domains. To-zone and recipient-count synthetic markers gate send risks.',
      },
    ],
    setup:
      'Paste a Resend API key (`re_*`) — Vaubaan stores it encrypted. The binding pins an operator-chosen slug (e.g. `prod-email`). Configure `internal_domains`, `allowlist_domains`, `allowlist_addresses` in binding metadata to drive the to-zone classification.',
    catalogPath: 'plugins/resend/src/risk-catalog.yaml',
    handbook: 'docs/handbook/providers/resend.md',
  },
  'cloudflare-dns': {
    slug: 'cloudflare-dns',
    label: 'Cloudflare DNS',
    pitch:
      'DNS plane — zones, records (A/AAAA/CNAME/MX/TXT/SRV/…), zone settings (SSL, TLS, cache level), DNSSEC, CDN cache purge, BIND import/export.',
    kind: 'cloud',
    dataModel: cloudflareDnsDataModel,
    tools: [],
    planes: [
      {
        slug: 'dns',
        label: 'DNS',
        pitch:
          'A Cloudflare account — zones, DNS records, zone settings, DNSSEC posture, CDN cache, BIND import/export.',
      },
    ],
    setup:
      'Paste a Cloudflare API Token scoped to the zones you want to expose (Zone:Read + DNS:Edit minimum). Vaubaan stores the token encrypted. The binding pins the account_id; zone-level scoping is enforced by the token itself.',
    catalogPath: 'plugins/cloudflare-dns/src/risk-catalog.yaml',
    handbook: 'docs/handbook/providers/cloudflare-dns.md',
  },
};

/** All provider slugs known to the info page. */
export const PROVIDER_SLUGS = Object.keys(PROVIDER_INFO) as readonly Provider[];

export function isProviderSlug(value: string): value is Provider {
  return (PROVIDER_SLUGS as readonly string[]).includes(value);
}

/**
 * Compute the set of plane slugs a risk entry touches, by intersecting each
 * `matches` pattern's entity names with each plane's entity set. Returns
 * the deduplicated list of plane slugs (one risk can span multiple planes
 * via a fallback pattern like `supabase.**.W` — those risks appear in
 * every plane page, which is correct).
 *
 * The algorithm is intentionally simple : tokenise the pattern on `.`,
 * strip the cardinality marker `[...]`, drop `R`/`W` trailing actions and
 * wildcards (`*` / `**`). Whatever remains and matches a declared entity
 * name in a plane → that plane is touched.
 */
export function risksForPlane(
  entries: readonly RiskEntry[],
  model: DataModel,
  planeSlug: string,
): readonly RiskEntry[] {
  const plane = model.planes.find((p) => p.slug === planeSlug);
  if (!plane) return [];
  const planeEntityNames = new Set(plane.entities.map((e) => e.name));

  // Entities that are UNIQUE to this plane (not shared with another plane).
  // A risk that mentions a unique entity definitively touches this plane.
  const uniqueToThisPlane = new Set<string>();
  // Entities unique to OTHER planes — a risk mentioning one of these is
  // definitively *not* this plane (it's a sibling plane's risk).
  const uniqueToOtherPlane = new Set<string>();
  const occurrences = new Map<string, number>();
  for (const p of model.planes) {
    for (const e of p.entities) {
      occurrences.set(e.name, (occurrences.get(e.name) ?? 0) + 1);
    }
  }
  for (const [name, count] of occurrences) {
    if (count !== 1) continue;
    if (planeEntityNames.has(name)) uniqueToThisPlane.add(name);
    else uniqueToOtherPlane.add(name);
  }

  return entries.filter((entry) =>
    riskTouchesPlane(entry, planeEntityNames, uniqueToThisPlane, uniqueToOtherPlane),
  );
}

function riskTouchesPlane(
  entry: RiskEntry,
  planeEntityNames: ReadonlySet<string>,
  uniqueToThisPlane: ReadonlySet<string>,
  uniqueToOtherPlane: ReadonlySet<string>,
): boolean {
  const patterns = typeof entry.matches === 'string' ? [entry.matches] : entry.matches;
  let anyPatternMatches = false;
  for (const pattern of patterns) {
    const tokens = extractEntityTokens(pattern);
    if (tokens.length === 0) {
      // Wildcard-only pattern (e.g. `supabase.**.R` / `.W`) — touches EVERY
      // plane (it's a fallback that catches anything not handled by a more
      // specific risk).
      return true;
    }
    const hasUniqueToThis = tokens.some((t) => uniqueToThisPlane.has(t));
    const hasUniqueToOther = tokens.some((t) => uniqueToOtherPlane.has(t));
    if (hasUniqueToThis) {
      anyPatternMatches = true;
      continue;
    }
    if (hasUniqueToOther) {
      // This pattern definitively belongs to another plane — skip.
      continue;
    }
    // Pattern only uses shared entities (e.g. `project.W` / `project-settings`)
    // — it touches every plane that contains those shared entities. Count as
    // a match when at least one shared token is in this plane.
    if (tokens.some((t) => planeEntityNames.has(t))) {
      anyPatternMatches = true;
    }
  }
  return anyPatternMatches;
}

/**
 * Extract the entity name tokens from a slice pattern. Strips the leading
 * provider segment, cardinality markers (`[…]`), action suffixes
 * (`.R` / `.W`), and wildcards.
 *
 * Examples :
 *   `supabase.project[**].bucket[**].object[**].W`
 *     → ['project', 'bucket', 'object']
 *   `supabase.**.W`
 *     → []
 *   `supabase.**.R`
 *     → []
 */
function extractEntityTokens(pattern: string): string[] {
  const out: string[] = [];
  for (const segment of pattern.split('.')) {
    const stripped = segment.replace(/\[.*?\]/g, '').trim();
    if (!stripped) continue;
    if (stripped === '*' || stripped === '**') continue;
    if (stripped === 'R' || stripped === 'W') continue;
    // Provider-name leading segment (`supabase`, `github`, …) — heuristic :
    // it is the first non-wildcard token AND matches no known cardinality.
    // We just push everything past that ; it gets filtered later when the
    // caller intersects with declared entity names.
    out.push(stripped);
  }
  // The first token is always the provider name (per the DSL grammar).
  if (out.length > 0) out.shift();
  return out;
}

/**
 * Filter tools to only those that target a specific plane. Requires
 * `toolPlanes` to be declared on the ProviderInfo — for single-plane
 * providers, all tools are returned regardless.
 */
export function toolsForPlane(
  info: ProviderInfo,
  planeSlug: string,
): ReadonlyArray<McpToolDeclaration> {
  if (info.planes.length <= 1) return info.tools;
  const map = info.toolPlanes;
  if (!map) return info.tools;
  return info.tools.filter((t) => map[t.name] === planeSlug);
}
