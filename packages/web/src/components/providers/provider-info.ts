/**
 * Provider info registry — central place mapping the URL slug
 * (`github`, `vercel`, `supabase`, `railway`, `bash`) to the
 * provider-package exports the info page needs (data-model, available
 * tools list, presentation copy).
 *
 * Spec : docs/spec/gateway-risk-model.md §1, §2.
 * Used by : `/orgs/[slug]/providers/[provider]/page.tsx`.
 */

import type { DataModel, McpToolDeclaration, Provider } from '@vaubaan/shared';

import { githubAvailableTools, githubDataModel } from '@vaubaan/providers-github';
import { vercelAvailableTools, vercelDataModel } from '@vaubaan/providers-vercel';
import { supabaseAvailableTools, supabaseDataModel } from '@vaubaan/providers-supabase';
import { railwayAvailableTools, railwayDataModel } from '@vaubaan/providers-railway';
import { sshAvailableTools, sshDataModel } from '@vaubaan/providers-ssh';

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
    setup:
      'Install the Vaubaan Gateway GitHub App on the org or user account that owns the repos you want to expose. Vaubaan mints short-lived installation tokens at runtime — no long-lived PAT is stored.',
    catalogPath: 'packages/providers/github/src/risk-catalog.yaml',
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
    setup:
      'Install the Vaubaan Marketplace Integration on the team that owns the projects you want to expose. Vaubaan stores the integration access token (refreshable) and proxies tool calls.',
    catalogPath: 'packages/providers/vercel/src/risk-catalog.yaml',
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
    setup:
      'Paste a Supabase Management API personal access token (PAT, `sbp_…`) — Vaubaan never sees the service_role key. Each project_ref the binding pins is reachable; everything else is denied at the runtime layer.',
    catalogPath: 'packages/providers/supabase/src/risk-catalog.yaml',
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
    setup:
      'Authorize the Vaubaan Gateway Railway app to manage the projects in your workspace. Vaubaan stores the OAuth refresh token and rotates the access token at each call.',
    catalogPath: 'packages/providers/railway/src/risk-catalog.yaml',
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
    setup:
      'Bash bindings live per-project (not org-level). Each binding pairs an annotated bash script with one or more SSH hosts. Hosts are registered via the `ssh_binding` form; commands are dispatched through `ssh__exec`.',
    catalogPath: 'packages/providers/ssh/src/risk-catalog.yaml',
    handbook: 'docs/handbook/providers/railway-ssh.md',
  },
};

/** All provider slugs known to the info page. */
export const PROVIDER_SLUGS = Object.keys(PROVIDER_INFO) as readonly Provider[];

export function isProviderSlug(value: string): value is Provider {
  return (PROVIDER_SLUGS as readonly string[]).includes(value);
}
