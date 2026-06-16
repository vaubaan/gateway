/**
 * Vercel — risk catalog (TS export, 1:1 with `risk-catalog.yaml`).
 *
 * Source of truth : `.vaubaan/research/providers/vercel.md` §3.
 * Spec           : `docs/spec/gateway-risk-model.md` §4.
 *
 * The YAML sibling is the canonical reviewable form ; this TS module is
 * what the runtime imports (no YAML dep at runtime — Vercel does not bundle
 * `.yaml` files in the Lambda). Keep both in sync — a CI test in
 * `tests/unit/risk-catalog-sync.test.ts` diffs the two structures.
 *
 * 15 named risks + 1 fallback = 16 total. RiskId format follows
 * `<provider>.<name>` (cf. shared/src/risk.ts RISK_ID_REGEX). The env
 * qualification is encoded in the risk *name* (`-prod`, `-preview`) rather
 * than via the bracketed `[<env>]` shorthand, because the runtime resolves
 * the env from the binding, not from the catalog literal.
 *
 * Slice patterns use the DSL declared in policy-engine/src/slice-dsl.ts
 * (no regex, only `[*]` / `[**]` wildcards and `[a,b,c]` lists). Each
 * pattern must match at least one tool's emitted slice — verified by the
 * `risk-catalog.test.ts` coverage lint.
 */

import type { RiskCatalog } from '@vaubaan/shared';

export const vercelRiskCatalog: RiskCatalog = {
  provider: 'vercel',
  risks: [
    // ─── READS ─────────────────────────────────────────────────────────────
    {
      id: 'vercel.read-account',
      label: 'Read account / team / project metadata',
      reason:
        'Inventory of teams, projects, deployments, build/runtime logs, env-var keys ' +
        '(encrypted), domains, toolbar threads. Surface of attack is negligible : ' +
        'metadata only, no plaintext secret leaks. This risk is the always-on baseline ' +
        'that every other read assumes.',
      matches: 'vercel.[**].R',
      vector: {
        reversibility: 'reversible',
        blast: 'single',
        data: 'metadata',
        cost: 'free',
        visibility: 'internal',
        persistence: 'stateless',
      },
    },
    {
      id: 'vercel.read-deployment',
      label: 'Read deployments + build/runtime logs',
      reason:
        'Runtime logs can carry app data (PII if the app logs by accident, OWASP LLM01 ' +
        'surface via tokens injected into logs). Standard posture for a coding agent ' +
        'in debug mode but still distinct from pure metadata read.',
      matches: 'vercel.project[**].deployment[**].R',
      vector: {
        reversibility: 'reversible',
        blast: 'single',
        data: 'data',
        cost: 'free',
        visibility: 'internal',
        persistence: 'stateless',
      },
    },
    {
      id: 'vercel.read-env-var',
      label: 'Read env vars (encrypted values only)',
      reason:
        'Listing of env-var keys with values returned encrypted by Vercel. No direct ' +
        'secret exfiltration possible. Discriminates from the plaintext variant which ' +
        'is the higher-severity write.',
      matches: 'vercel.project[**].env-var[*].R',
      vector: {
        reversibility: 'reversible',
        blast: 'single',
        data: 'metadata',
        cost: 'free',
        visibility: 'internal',
        persistence: 'stateless',
      },
    },
    {
      id: 'vercel.read-env-var-plaintext',
      label: 'Read env vars in plaintext (`decrypt=true`)',
      reason:
        '`list_env_vars` with `decrypt=true` returns Stripe keys, DB URLs, JWT signing ' +
        'secrets etc. in the clear. Equivalent to a full credentials compromise on the ' +
        'project. Distinct risk class from the encrypted read.',
      matches: 'vercel.project[**].env-var[*].plaintext.R',
      vector: {
        reversibility: 'reversible',
        blast: 'account',
        data: 'secret',
        cost: 'free',
        visibility: 'internal',
        persistence: 'stateless',
      },
    },
    {
      id: 'vercel.fetch-deployment-url',
      label: 'HTTP fetch to a Vercel deployment URL',
      reason:
        '`web_fetch_vercel_url` makes an outbound HTTP request against a deployment ' +
        'URL. Logs an access on the target side, may consume bandwidth. Not a major ' +
        'security risk but worth a dedicated risk for audit-log granularity.',
      matches: 'vercel.project[**].deployment[**].fetch.R',
      vector: {
        reversibility: 'reversible',
        blast: 'single',
        data: 'data',
        cost: 'free',
        visibility: 'public',
        persistence: 'stateless',
      },
    },

    // ─── WRITES — DEPLOYMENT-PROTECTION BYPASS (credential mint) ───────────
    {
      id: 'vercel.mint-bypass-token',
      label: 'Mint a deployment-protection bypass token',
      reason:
        'Credential creation. The token bypasses SSO / Password Gate on a single ' +
        'deployment URL with a short TTL. Exposing the URL out-of-band bypasses the ' +
        'project deployment-protection.',
      matches: 'vercel.project[**].deployment[**].bypass-token.W',
      vector: {
        reversibility: 'reversible',
        blast: 'single',
        data: 'secret',
        cost: 'free',
        visibility: 'internal',
        persistence: 'session',
      },
    },

    // ─── WRITES — DEPLOYMENT ───────────────────────────────────────────────
    {
      id: 'vercel.deploy-preview',
      label: 'Trigger a preview / development deploy',
      reason:
        'No prod impact. The build runs on Vercel infra, the URL is non-indexed ' +
        'preview / development. Reversible (preview builds expire or can be deleted by ' +
        'the team).',
      matches: 'vercel.project[**].env[preview,development].deployment.W',
      vector: {
        reversibility: 'reversible',
        blast: 'single',
        data: 'data',
        cost: 'moderate',
        visibility: 'team',
        persistence: 'session',
      },
    },
    {
      id: 'vercel.deploy-prod',
      label: 'Trigger a production deploy',
      reason:
        'Public, costly to roll back (prod alias re-pointed, CDN cache invalidated, ' +
        'release-note / comms downstream). Immediate impact on end visitors.',
      matches: 'vercel.project[**].env[prod].deployment.W',
      vector: {
        reversibility: 'costly',
        blast: 'env',
        data: 'data',
        cost: 'moderate',
        visibility: 'public',
        persistence: 'session',
      },
    },

    // ─── WRITES — TOOLBAR (low-risk feedback comments) ─────────────────────
    {
      id: 'vercel.toolbar-write',
      label: 'Write / edit / react on toolbar threads',
      reason:
        'UI comment surface on deployment previews. Visible to the team only, ' +
        'reversible via delete/edit, zero effect on build / runtime / routing. ' +
        'Semantically a mutate but the risk is minimal.',
      matches: 'vercel.project[**].deployment[**].toolbar-thread[**].W',
      vector: {
        reversibility: 'reversible',
        blast: 'single',
        data: 'data',
        cost: 'free',
        visibility: 'team',
        persistence: 'session',
      },
    },

    // ─── WRITES — ENV VARS (secrets) ───────────────────────────────────────
    {
      id: 'vercel.env-var-write-preview',
      label: 'Write env var on preview / development',
      reason:
        'Affects future preview / development builds. No direct prod impact but the ' +
        'stored value is still a secret on the Vercel side. Acceptable for a coding ' +
        'agent that opens its own PRs.',
      matches: 'vercel.project[**].env[preview,development].env-var[**].W',
      vector: {
        reversibility: 'reversible',
        blast: 'env',
        data: 'secret',
        cost: 'free',
        visibility: 'internal',
        persistence: 'posture',
      },
    },
    {
      id: 'vercel.env-var-write-prod',
      label: 'Write env var on prod',
      reason:
        'Posture-shift on prod credentials (DB url, JWT secret, API keys). A bad value ' +
        'breaks the service at the next deploy ; an attacker- injected value exfiltrates ' +
        'traffic or takes over the app.',
      matches: 'vercel.project[**].env[prod].env-var[**].W',
      vector: {
        reversibility: 'costly',
        blast: 'env',
        data: 'secret',
        cost: 'free',
        visibility: 'internal',
        persistence: 'posture',
      },
    },
    {
      id: 'vercel.env-var-fan-out',
      label: 'Write env var on every env in one call (prod included)',
      reason:
        "`upsert_env_var target=['production','preview','development']` (or target " +
        'omitted = all 3 by Vercel default), and `delete_env_var` (whose upstream API ' +
        'removes the var from every env it lives in regardless of the Vaubaan hint), ' +
        'touch all 3 envs in a single tool call. Treated as its own risk so the ' +
        'agent who only has `env-var-write-preview` accepted does NOT silently ' +
        'escalate to prod.',
      matches: 'vercel.project[**].env-var-fan-out.W',
      vector: {
        reversibility: 'costly',
        blast: 'bulk',
        data: 'secret',
        cost: 'free',
        visibility: 'internal',
        persistence: 'posture',
      },
    },

    // ─── WRITES — PROJECT SETTINGS (build pipeline) ────────────────────────
    {
      id: 'vercel.project-settings-write',
      label: 'Update project settings (framework, build cmd, node version, root dir)',
      reason:
        'Modifies the build pipeline for *every* future deployment of all 3 envs. A ' +
        'bad install / build command breaks preview AND prod at the next push. ' +
        'Posture-shift on the CI chain.',
      matches: 'vercel.project[**].project-settings.W',
      vector: {
        reversibility: 'costly',
        blast: 'account',
        data: 'metadata',
        cost: 'free',
        visibility: 'internal',
        persistence: 'posture',
      },
    },

    // ─── WRITES — DEPLOYMENT-PROTECTION (governance) ───────────────────────
    {
      id: 'vercel.deployment-protection-write',
      label: 'Enable / disable / configure deployment protection (SSO + password)',
      reason:
        'Governance of access to deployments. Disabling protection exposes a ' +
        'previously-internal preview ; modifying the password breaks existing human ' +
        'accesses. External-visible posture-shift.',
      matches: 'vercel.project[**].deployment-protection.W',
      vector: {
        reversibility: 'reversible',
        blast: 'account',
        data: 'secret',
        cost: 'free',
        visibility: 'team',
        persistence: 'posture',
      },
    },

    // ─── WRITES — DOMAINS (DNS posture-shift externe) ──────────────────────
    {
      id: 'vercel.domain-write',
      label: 'Attach / verify / detach a custom domain',
      reason:
        'External DNS coupling. Attach → public routing (can hijack traffic from a ' +
        'domain the org controls). Detach → breaks the public service if the domain is ' +
        'prod. Verify is idempotent but folded into the same risk for UX simplicity.',
      matches: 'vercel.project[**].domain[**].W',
      vector: {
        reversibility: 'costly',
        blast: 'account',
        data: 'metadata',
        cost: 'free',
        visibility: 'public',
        persistence: 'posture',
      },
    },

    // ─── FALLBACK (required) ───────────────────────────────────────────────
    {
      id: 'vercel.uncategorized-write',
      label: 'Uncategorized Vercel write',
      reason:
        'Catch-all for writes that have not been explicitly categorised. If observed ' +
        'in production, signals that a tool was added without a matching catalog ' +
        'entry — operators must opt in explicitly (no implicit accept).',
      matches: 'vercel.[**].W',
      vector: {
        reversibility: 'costly',
        blast: 'env',
        data: 'data',
        cost: 'free',
        visibility: 'internal',
        persistence: 'session',
      },
    },
  ],
};
