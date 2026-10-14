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
import {
  admissionProblem,
  LEGACY_PROVIDER_ID,
  normalizeEmailDomains,
} from '../config/sign-in';
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
  invitationOnly: 'idp.invitation_only',
} as const;

/** The object id of the IdP settings in an administrative audit entry. */
export const IDP_CONFIG_OBJECT_ID = 'idp';

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
  /** Only invited addresses and the admin emails are admitted. Absent: false. */
  readonly invitationOnly?: boolean;
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
    const given = input.clientSecret?.trim() || null;
    const existingSecret = await this.config.getSecret(IDP_CONFIG_KEYS.clientSecret);
    // A blank field keeps the stored secret — for the identity provider it was given
    // for. Under another issuer it would be sent to that issuer's token endpoint.
    const storedIssuer = await this.config.get(IDP_CONFIG_KEYS.issuer);
    const issuerChanged =
      issuer !== null && storedIssuer !== null && !sameIssuer(issuer, storedIssuer);
    const clientSecret = given ?? (issuerChanged ? null : existingSecret);
    if (!clientSecret) {
      problems.push(
        issuerChanged && existingSecret
          ? 'client secret is required when the issuer changes: the stored secret belongs to the previous identity provider'
          : 'client secret is required',
      );
    }
    const claims = normalizeClaims(input.claims, problems);
    const allowedEmailDomains = normalizeEmailDomains(input.allowedEmailDomains, problems);
    const invitationOnly = input.invitationOnly === true;
    if (issuer) {
      const admission = admissionProblem({
        id: LEGACY_PROVIDER_ID,
        kind: 'oidc',
        issuer,
        allowedEmailDomains,
        invitationOnly,
      });
      if (admission) problems.push(admission);
    }
    if (problems.length > 0 || !issuer || !clientSecret) throw new IdpSettingsError(problems);

    // One transaction: never the issuer of one IdP with the secret or the
    // claim mapping of another.
    await this.config.apply([
      { kind: 'value', key: IDP_CONFIG_KEYS.issuer, value: issuer.href },
      { kind: 'value', key: IDP_CONFIG_KEYS.clientId, value: clientId },
      { kind: 'secret', key: IDP_CONFIG_KEYS.clientSecret, plain: clientSecret },
      { kind: 'value', key: IDP_CONFIG_KEYS.claimSub, value: claims.sub },
      { kind: 'value', key: IDP_CONFIG_KEYS.claimEmail, value: claims.email },
      { kind: 'value', key: IDP_CONFIG_KEYS.claimGroups, value: claims.groups },
      {
        kind: 'value',
        key: IDP_CONFIG_KEYS.allowedEmailDomains,
        value: JSON.stringify(allowedEmailDomains),
      },
      { kind: 'value', key: IDP_CONFIG_KEYS.invitationOnly, value: String(invitationOnly) },
    ]);
    return { issuer, clientId, clientSecret, claims, allowedEmailDomains, invitationOnly };
  }

  private async readStored(): Promise<IdpConfig | null> {
    const [issuerRaw, clientId, clientSecret] = await Promise.all([
      this.config.get(IDP_CONFIG_KEYS.issuer),
      this.config.get(IDP_CONFIG_KEYS.clientId),
      this.config.getSecret(IDP_CONFIG_KEYS.clientSecret),
    ]);
    if (!issuerRaw || !clientId || !clientSecret) return null;
    const [sub, email, groups, domainsRaw, invitationOnlyRaw] = await Promise.all([
      this.config.get(IDP_CONFIG_KEYS.claimSub),
      this.config.get(IDP_CONFIG_KEYS.claimEmail),
      this.config.get(IDP_CONFIG_KEYS.claimGroups),
      this.config.get(IDP_CONFIG_KEYS.allowedEmailDomains),
      this.config.get(IDP_CONFIG_KEYS.invitationOnly),
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
      invitationOnly: invitationOnlyRaw === 'true',
    };
  }
}

/** The same issuer when the URL parser normalises both to the same text (scheme and host case, default port). */
function sameIssuer(issuer: URL, storedRaw: string): boolean {
  try {
    return new URL(storedRaw).href === issuer.href;
  } catch {
    return false;
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
