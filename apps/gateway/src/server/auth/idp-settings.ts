/**
 * The effective identity-provider settings (spec §4.3, §4.2 "Administration").
 *
 * Two sources, one precedence rule inherited from the configuration loader:
 * the mounted file / environment (`InstanceConfig.idp`) **wins** over what the
 * operator saved from the Admin page into `instance_config`. When the file
 * sets the IdP the Admin page is read-only; otherwise the page writes the
 * store, the client secret sealed by the `Encryptor` under
 * `instance_config:idp.client_secret`.
 */
import type { IdpClaimMapping, IdpConfig } from '../config/types';
import type { ConfigRepo } from '../store/repositories/config';
import { IdpSettingsError } from './errors';

export const IDP_CONFIG_KEYS = {
  issuer: 'idp.issuer',
  clientId: 'idp.client_id',
  clientSecret: 'idp.client_secret',
  claimSub: 'idp.claims.sub',
  claimEmail: 'idp.claims.email',
  claimGroups: 'idp.claims.groups',
  allowedEmailDomains: 'idp.allowed_email_domains',
} as const;

/** Same defaults as the configuration loader (`config/load.ts`). */
export const DEFAULT_CLAIM_MAPPING: IdpClaimMapping = {
  sub: 'sub',
  email: 'email',
  groups: 'groups',
};

export type IdpSource = 'file' | 'store';

export interface EffectiveIdp {
  readonly settings: IdpConfig;
  readonly source: IdpSource;
}

export interface IdpSettingsInput {
  readonly issuer: string;
  readonly clientId: string;
  /** `null` keeps the secret already stored (the form never echoes it). */
  readonly clientSecret: string | null;
  readonly claims: IdpClaimMapping;
  readonly allowedEmailDomains: readonly string[];
}

export interface IdpSettingsOptions {
  /** Tests only: accept an `http://` issuer for the in-process IdP fixture. */
  readonly allowInsecureIssuer?: boolean;
}

export class IdpSettingsService {
  constructor(
    private readonly fromFile: IdpConfig | null,
    private readonly config: ConfigRepo,
    private readonly options: IdpSettingsOptions = {},
  ) {}

  /** True when the mounted configuration sets the IdP: the Admin page cannot change it. */
  get readOnly(): boolean {
    return this.fromFile !== null;
  }

  async current(): Promise<EffectiveIdp | null> {
    if (this.fromFile) return { settings: this.fromFile, source: 'file' };
    const stored = await this.readStored();
    return stored ? { settings: stored, source: 'store' } : null;
  }

  /** What the Admin form shows: the stored values, secret elided. */
  async stored(): Promise<(Omit<IdpConfig, 'clientSecret'> & { hasClientSecret: boolean }) | null> {
    const settings = await this.readStored();
    if (!settings) return null;
    const { clientSecret: _secret, ...rest } = settings;
    return { ...rest, hasClientSecret: true };
  }

  async save(input: IdpSettingsInput): Promise<IdpConfig> {
    if (this.readOnly) {
      throw new IdpSettingsError([
        'the identity provider is set by the mounted configuration (idp.* / VAUBAAN_IDP_*); edit it there',
      ]);
    }
    const problems: string[] = [];
    const issuer = parseIssuer(input.issuer, this.options.allowInsecureIssuer === true, problems);
    const clientId = input.clientId.trim();
    if (clientId.length === 0) problems.push('client id is required');
    const existingSecret = await this.config.getSecret(IDP_CONFIG_KEYS.clientSecret);
    const clientSecret = input.clientSecret?.trim() || existingSecret;
    if (!clientSecret) problems.push('client secret is required');
    const claims = normalizeClaims(input.claims, problems);
    const allowedEmailDomains = normalizeDomains(input.allowedEmailDomains, problems);
    if (problems.length > 0 || !issuer || !clientSecret) throw new IdpSettingsError(problems);

    await this.config.set(IDP_CONFIG_KEYS.issuer, issuer.href);
    await this.config.set(IDP_CONFIG_KEYS.clientId, clientId);
    await this.config.setSecret(IDP_CONFIG_KEYS.clientSecret, clientSecret);
    await this.config.set(IDP_CONFIG_KEYS.claimSub, claims.sub);
    await this.config.set(IDP_CONFIG_KEYS.claimEmail, claims.email);
    await this.config.set(IDP_CONFIG_KEYS.claimGroups, claims.groups);
    await this.config.set(IDP_CONFIG_KEYS.allowedEmailDomains, JSON.stringify(allowedEmailDomains));
    return { issuer, clientId, clientSecret, claims, allowedEmailDomains };
  }

  private async readStored(): Promise<IdpConfig | null> {
    const [issuerRaw, clientId, clientSecret] = await Promise.all([
      this.config.get(IDP_CONFIG_KEYS.issuer),
      this.config.get(IDP_CONFIG_KEYS.clientId),
      this.config.getSecret(IDP_CONFIG_KEYS.clientSecret),
    ]);
    if (!issuerRaw || !clientId || !clientSecret) return null;
    const [sub, email, groups, domainsRaw] = await Promise.all([
      this.config.get(IDP_CONFIG_KEYS.claimSub),
      this.config.get(IDP_CONFIG_KEYS.claimEmail),
      this.config.get(IDP_CONFIG_KEYS.claimGroups),
      this.config.get(IDP_CONFIG_KEYS.allowedEmailDomains),
    ]);
    return {
      issuer: new URL(issuerRaw),
      clientId,
      clientSecret,
      claims: {
        sub: sub ?? DEFAULT_CLAIM_MAPPING.sub,
        email: email ?? DEFAULT_CLAIM_MAPPING.email,
        groups: groups ?? DEFAULT_CLAIM_MAPPING.groups,
      },
      allowedEmailDomains: parseDomainsJson(domainsRaw),
    };
  }
}

function parseIssuer(raw: string, allowInsecure: boolean, problems: string[]): URL | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    problems.push('issuer must be a URL');
    return null;
  }
  if (url.protocol !== 'https:' && !(allowInsecure && url.protocol === 'http:')) {
    problems.push('issuer must use https');
    return null;
  }
  if (url.search || url.hash) {
    problems.push('issuer must not carry a query string or fragment');
    return null;
  }
  return url;
}

function normalizeClaims(claims: IdpClaimMapping, problems: string[]): IdpClaimMapping {
  const out = { sub: claims.sub.trim(), email: claims.email.trim(), groups: claims.groups.trim() };
  for (const [name, value] of Object.entries(out)) {
    if (value.length === 0) problems.push(`claim name for '${name}' is required`);
  }
  return out;
}

function normalizeDomains(domains: readonly string[], problems: string[]): string[] {
  const out: string[] = [];
  for (const raw of domains) {
    const domain = raw.trim().toLowerCase();
    if (domain.length === 0) continue;
    if (domain.includes('@') || /\s/.test(domain)) {
      problems.push(`'${domain}' is not a domain name`);
      continue;
    }
    if (!out.includes(domain)) out.push(domain);
  }
  return out;
}

function parseDomainsJson(raw: string | null): string[] {
  if (!raw) return [];
  const parsed: unknown = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed.filter((d): d is string => typeof d === 'string') : [];
}

/** Splits the textarea/env style input: whitespace, comma or newline separated. */
export function splitList(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
