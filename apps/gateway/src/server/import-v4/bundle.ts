/**
 * The bundle the v4 exporter (`scripts/export-v4.mjs`) writes on its stdout
 * and the importer reads on its stdin (ADR import-from-v4-one-shot-importer
 * D2). It is checked whole, strictly, before anything is written: an unknown
 * key anywhere refuses it, so a field the exporter adds later is never
 * silently ignored, and a secret is accepted only where the importer uses one.
 *
 * Handbook: docs/handbook/import-from-v4.md.
 */
import { z } from 'zod';

import { PASTED_KEY_PROVIDERS } from './credential-mapping';

export const BUNDLE_FORMAT = 'vaubaan-v4-export';
export const BUNDLE_VERSION = 1;

/** Largest bundle the importer reads from stdin. A v4 organization is far below. */
export const MAX_BUNDLE_BYTES = 8 * 1024 * 1024;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** The v4 slug grammar (`organizations.slug`, `projects.slug`, token names). */
const SLUG = /^[a-z0-9](-?[a-z0-9])*$/;
/** The v4 risk id grammar (migration 0042, `valid_risk_id_array`). */
const V4_RISK_ID = /^[a-z][a-z0-9-]*(\[[a-z][a-z0-9-]*\])?(\.[a-z][a-z0-9-]+)+$/;

const id = z.string().regex(UUID);
const slug = z.string().max(100).regex(SLUG);
const name = z.string().min(1).max(300);
const iso = z
  .string()
  .max(64)
  .refine((value) => Number.isFinite(Date.parse(value)), 'not a date');
/** A secret value: bounded, never echoed by the importer. */
const secret = z.string().min(1).max(16_384);

const organizationSchema = z.object({ id, slug, name }).strict();

const projectSchema = z.object({ id, slug, name }).strict();

/**
 * One `provider_admins` row: the account an organization connected once per
 * provider. `access_token` is present only for the providers whose key is
 * imported as is (`PASTED_KEY_PROVIDERS`); the exporter never decrypts the
 * others (GitHub installation, Railway and Supabase OAuth grants).
 */
const accountSchema = z
  .object({
    id,
    provider: slug,
    status: z.enum(['connected', 'expired', 'revoked']),
    team_id: z.string().max(200).nullable(),
    installation_id: z.string().max(200).nullable(),
    access_token: secret.nullable(),
  })
  .strict()
  .refine(
    (account) =>
      account.access_token === null ||
      (PASTED_KEY_PROVIDERS as readonly string[]).includes(account.provider),
    { message: 'carries a secret for a provider whose secret is never imported' },
  );

/** One `provider_bindings` row (deduplicated by the importer). */
const bindingSchema = z
  .object({
    project_id: id,
    provider: slug,
    resource_ref: z.string().min(1).max(500),
    display_name: z.string().max(500).nullable(),
    /** The v4 label as stored: sometimes `prod`, sometimes junk such as a project name. */
    environment: z.string().max(200).nullable(),
  })
  .strict();

/** One Stripe account of the organization, with the keys of `stripe_bindings`. */
const stripeAccountSchema = z
  .object({
    account_id: z.string().min(1).max(200),
    project_ids: z.array(id).max(1000),
    test_key: secret.nullable(),
    live_key: secret.nullable(),
  })
  .strict()
  .refine((account) => account.test_key !== null || account.live_key !== null, {
    message: 'carries neither a test key nor a live key',
  });

/** One SSH host asked with `--ssh-host`, from whichever organization holds it. */
const sshHostSchema = z
  .object({
    host_slug: slug,
    host_address: z.string().min(1).max(253),
    port: z.number().int().min(1).max(65_535),
    user: z.string().min(1).max(64),
    private_key: secret,
    /** Given to the exporter by the operator (`--ssh-host-key`): v4 pinned no host key. */
    host_key_fingerprint: z.string().min(1).max(100),
    source_org: slug,
    /** The projects of the exported organization bound to this host slug. */
    project_ids: z.array(id).max(1000),
  })
  .strict();

/** One v4 root token that is active, reusable and not expired: a working setup. */
const missionSchema = z
  .object({
    token_id: id,
    project_id: id,
    token_name: slug,
    accepted_risks: z.array(z.string().max(200).regex(V4_RISK_ID)).max(2000),
    expires_at: iso.nullable(),
  })
  .strict();

const skippedSchema = z
  .object({
    /** `project_env_vars` rows: v5 has no per-project variable store. */
    project_env_vars: z.number().int().min(0),
    /** Tokens delegated from another token: v5 has no sub-mission. */
    child_tokens: z.number().int().min(0),
    /** `bash_bindings` rows: v5 has no bash provider. */
    bash_bindings: z.number().int().min(0),
    /** SSH host slugs of the organization the operator did not ask for. */
    ssh_hosts_not_exported: z.array(slug).max(1000),
  })
  .strict();

export const bundleSchema = z
  .object({
    format: z.literal(BUNDLE_FORMAT),
    version: z.literal(BUNDLE_VERSION),
    exported_at: iso,
    organization: organizationSchema,
    projects: z.array(projectSchema).max(1000),
    accounts: z.array(accountSchema).max(1000),
    bindings: z.array(bindingSchema).max(20_000),
    stripe_accounts: z.array(stripeAccountSchema).max(100),
    ssh_hosts: z.array(sshHostSchema).max(100),
    missions: z.array(missionSchema).max(1000),
    skipped: skippedSchema,
  })
  .strict()
  .superRefine((bundle, ctx) => {
    const projects = new Set(bundle.projects.map((p) => p.id));
    const check = (projectId: string, path: (string | number)[]) => {
      if (!projects.has(projectId)) {
        ctx.addIssue({ code: 'custom', path, message: 'names a project the bundle does not list' });
      }
    };
    bundle.bindings.forEach((b, i) => check(b.project_id, ['bindings', i, 'project_id']));
    bundle.missions.forEach((m, i) => check(m.project_id, ['missions', i, 'project_id']));
    bundle.stripe_accounts.forEach((a, i) =>
      a.project_ids.forEach((p, j) => check(p, ['stripe_accounts', i, 'project_ids', j])),
    );
    bundle.ssh_hosts.forEach((h, i) =>
      h.project_ids.forEach((p, j) => check(p, ['ssh_hosts', i, 'project_ids', j])),
    );
  });

export type V4Bundle = z.infer<typeof bundleSchema>;
export type V4Account = V4Bundle['accounts'][number];
export type V4Binding = V4Bundle['bindings'][number];
export type V4StripeAccount = V4Bundle['stripe_accounts'][number];
export type V4SshHost = V4Bundle['ssh_hosts'][number];
export type V4Mission = V4Bundle['missions'][number];
export type V4Project = V4Bundle['projects'][number];

export type ParsedBundle =
  | { readonly ok: true; readonly bundle: V4Bundle }
  | { readonly ok: false; readonly problems: readonly string[] };

/**
 * Parses the raw stdin text. The problems name a path and a rule, never a
 * value: a JSON syntax error is reported without the parser's message (V8
 * quotes the input around the error, which may be a secret).
 */
export function parseBundle(text: string): ParsedBundle {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, problems: ['the bundle is not valid JSON'] };
  }
  const result = bundleSchema.safeParse(raw);
  if (result.success) return { ok: true, bundle: result.data };
  return {
    ok: false,
    problems: result.error.issues.slice(0, 50).map((issue) => {
      const path = issue.path.map(String).join('.');
      return `${path || '(root)'}: ${issue.code === 'unrecognized_keys' ? `unknown key(s) ${issue.keys.join(', ')}` : issue.message}`;
    }),
  };
}

/** Every secret value of the bundle, so the importer can blank them out of anything it prints. */
export function secretsOf(bundle: V4Bundle): string[] {
  const values: (string | null)[] = [
    ...bundle.accounts.map((a) => a.access_token),
    ...bundle.stripe_accounts.flatMap((a) => [a.test_key, a.live_key]),
    ...bundle.ssh_hosts.map((h) => h.private_key),
  ];
  return values.filter((v): v is string => v !== null && v.length > 0);
}
