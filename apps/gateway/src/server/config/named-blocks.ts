/**
 * The families of named blocks (`sign_in.<id>.*`, `oauth_brokers.<name>.*`): their
 * fields, the prefix of their variables, and the mapping between a variable name and
 * a configuration path.
 */
export const SIGN_IN_ENV_PREFIX = 'VAUBAAN_SIGN_IN_';

/**
 * The fields of one sign-in provider (`sign_in.<id>.<field>`), with the suffix of
 * its environment variable (`VAUBAAN_SIGN_IN_<ID>_<SUFFIX>`) and how that variable
 * is read. One table: the loader, the env reader and the handbook's row derive from it.
 */
export const SIGN_IN_FIELDS = [
  { field: 'kind', env: 'KIND', kind: 'string' },
  { field: 'name', env: 'NAME', kind: 'string' },
  { field: 'issuer', env: 'ISSUER', kind: 'string' },
  { field: 'client_id', env: 'CLIENT_ID', kind: 'string' },
  { field: 'client_secret', env: 'CLIENT_SECRET', kind: 'secret' },
  { field: 'claims.sub', env: 'CLAIM_SUB', kind: 'string' },
  { field: 'claims.email', env: 'CLAIM_EMAIL', kind: 'string' },
  { field: 'claims.groups', env: 'CLAIM_GROUPS', kind: 'string' },
  { field: 'claims.email_verified', env: 'CLAIM_EMAIL_VERIFIED', kind: 'string' },
  { field: 'allowed_email_domains', env: 'ALLOWED_EMAIL_DOMAINS', kind: 'list' },
  { field: 'invitation_only', env: 'INVITATION_ONLY', kind: 'bool' },
  { field: 'require_verified_email', env: 'REQUIRE_VERIFIED_EMAIL', kind: 'bool' },
] as const satisfies readonly NamedBlockField[];
export type SignInField = (typeof SIGN_IN_FIELDS)[number]['field'];

export const OAUTH_BROKER_ENV_PREFIX = 'VAUBAAN_OAUTH_BROKER_';

/**
 * The fields of one OAuth broker the instance is enrolled with
 * (`oauth_brokers.<name>.<field>`, ADR google-calendar-through-an-oauth-broker
 * D1), with the suffix of its variable (`VAUBAAN_OAUTH_BROKER_<NAME>_<SUFFIX>`).
 * `key` is a secret like every other: a `_FILE` sibling or `${file:…}`.
 * `attestation` is `required` (the default) or `none` (ADR
 * oauth-broker-stateless-in-an-attested-enclave D4).
 */
export const OAUTH_BROKER_FIELDS = [
  { field: 'url', env: 'URL', kind: 'string' },
  { field: 'key', env: 'KEY', kind: 'secret' },
  { field: 'providers', env: 'PROVIDERS', kind: 'list' },
  { field: 'attestation', env: 'ATTESTATION', kind: 'string' },
] as const satisfies readonly NamedBlockField[];

/** One field of a family of named blocks (`sign_in.<id>.*`, `oauth_brokers.<name>.*`). */
export interface NamedBlockField {
  readonly field: string;
  readonly env: string;
  readonly kind: 'string' | 'secret' | 'list' | 'bool';
}

/**
 * A family of named blocks: the top-level key, the prefix of its variables
 * (`<prefix><NAME>_<SUFFIX>`, a hyphen of the name ↔ an underscore) and its
 * fields. The env reader, `envNamesFor`, `isSecretKeyPath` and
 * `secretEnvVariables` read every family from `NAMED_BLOCKS`.
 */
export interface NamedBlock {
  readonly top: string;
  /** What one block is, in an error message ("sign-in provider"). */
  readonly noun: string;
  readonly prefix: string;
  readonly fields: readonly NamedBlockField[];
}

export const SIGN_IN_BLOCK: NamedBlock = {
  top: 'sign_in',
  noun: 'sign-in provider',
  prefix: SIGN_IN_ENV_PREFIX,
  fields: SIGN_IN_FIELDS,
};
export const OAUTH_BROKER_BLOCK: NamedBlock = {
  top: 'oauth_brokers',
  noun: 'OAuth broker',
  prefix: OAUTH_BROKER_ENV_PREFIX,
  fields: OAUTH_BROKER_FIELDS,
};
export const NAMED_BLOCKS: readonly NamedBlock[] = [SIGN_IN_BLOCK, OAUTH_BROKER_BLOCK];

/** `<prefix><NAME>_<SUFFIX>`: a hyphen of the name becomes an underscore. */
export function namedBlockEnvName(block: NamedBlock, name: string, suffix: string): string {
  return `${block.prefix}${name.toUpperCase().replace(/-/g, '_')}_${suffix}`;
}

/** `VAUBAAN_SIGN_IN_<ID>_<SUFFIX>`: a hyphen of the provider id becomes an underscore. */
export function signInEnvName(signInProviderId: string, suffix: string): string {
  return namedBlockEnvName(SIGN_IN_BLOCK, signInProviderId, suffix);
}

/**
 * `VAUBAAN_SIGN_IN_ACME_ENTRA_CLIENT_ID` → `{ name: 'acme-entra', spec: client_id }`;
 * `null` when the variable is not of the family, does not end with a known
 * field or has no name part.
 */
export function parseNamedBlockEnvName(
  block: NamedBlock,
  variable: string,
): { name: string; spec: NamedBlockField } | null {
  if (!variable.startsWith(block.prefix)) return null;
  const rest = variable.slice(block.prefix.length);
  const spec = [...block.fields]
    .sort((a, b) => b.env.length - a.env.length)
    .find((f) => rest.endsWith(`_${f.env}`));
  if (!spec) return null;
  const namePart = rest.slice(0, -(spec.env.length + 1));
  if (namePart.length === 0) return null;
  return { name: namePart.toLowerCase().replace(/_/g, '-'), spec };
}

/** `VAUBAAN_SIGN_IN_ACME_ENTRA_CLIENT_ID` → `{ providerId: 'acme-entra', spec: client_id }`. */
export function parseSignInEnvName(
  name: string,
): { signInProviderId: string; spec: (typeof SIGN_IN_FIELDS)[number] } | null {
  const parsed = parseNamedBlockEnvName(SIGN_IN_BLOCK, name);
  if (!parsed) return null;
  const spec = SIGN_IN_FIELDS.find((f) => f.field === parsed.spec.field);
  return spec ? { signInProviderId: parsed.name, spec } : null;
}
