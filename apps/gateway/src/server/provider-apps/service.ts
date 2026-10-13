/**
 * The effective provider-app settings (spec §4.3 "per provider in use, the app
 * registered by the company"; §4.2 Administration; §7.1).
 *
 * Two sources and the precedence of the configuration loader: a
 * `providers.<id>` block of the mounted file / environment **wins** over what
 * the operator saved from Admin → Provider apps into `instance_config`. A
 * provider set by the file is read-only on the page. Stored values live under
 * `provider_apps.<id>.<field>`; secret fields are sealed by the `Encryptor`
 * (associated data `instance_config:provider_apps.<id>.<field>`).
 *
 * Which fields exist comes from the plugin (`fields.ts`); this module holds
 * no provider list.
 *
 * One operator decision is not a field of the app: whether an `app-install`
 * provider whose plugin declares no `userVerification` may be connected at
 * all (`accept unverified installations`, off by default). It is stored under
 * `provider_app_flags.<id>.accept_unverified_installations`, only from the
 * Admin page, whatever the source of the fields.
 */
import type {
  CredentialField,
  CredentialSpec,
  PluginRegistry,
  ProviderAppConfig,
} from '@vaubaan/plugin-sdk';

import {
  PROVIDER_APP_FIELD_PROPERTY,
  PROVIDER_APP_FIELDS,
  type ProviderAppConfig as FileProviderAppConfig,
} from '../config/types';
import type { ConfigRepo, ConfigWrite } from '../store/repositories/config';
import {
  APP_FIELD_NAME_PATTERN,
  appConfigFieldsOf,
  CLIENT_SECRET_FIELD,
  isRequired,
} from './fields';

export const PROVIDER_APP_KEY_PREFIX = 'provider_apps';
export const PROVIDER_APP_FLAG_PREFIX = 'provider_app_flags';
const ACCEPT_UNVERIFIED_FLAG = 'accept_unverified_installations';
const FLAG_ON = 'true';

export type ProviderAppSource = 'file' | 'store' | 'none';

/**
 * How an installation is bound to the human who connects it:
 *   `verified`             the plugin declares `userVerification`; the host proves it
 *   `unverified-refused`   it does not; connecting is refused (the default)
 *   `unverified-accepted`  it does not; the operator accepted the risk explicitly
 */
export type InstallVerification = 'verified' | 'unverified-refused' | 'unverified-accepted';

export interface ProviderAppStatus {
  readonly providerId: string;
  readonly displayName: string;
  readonly experimental: boolean;
  readonly credentialKind: CredentialSpec['kind'];
  /** False for `api-key` / `ssh-key` providers: nothing to configure, always connectable. */
  readonly needsApp: boolean;
  readonly fields: readonly CredentialField[];
  readonly source: ProviderAppSource;
  /** Every required field has a value: users may connect this provider. */
  readonly configured: boolean;
  /** Names of the required fields still missing. */
  readonly missing: readonly string[];
  /** Current values of the non-secret fields (for the form and the audit entry). */
  readonly values: Readonly<Record<string, string>>;
  /** Names of the secret fields that hold a value; the value itself is never returned. */
  readonly secretsSet: readonly string[];
  /** `null` for every kind but `app-install`. */
  readonly installVerification: InstallVerification | null;
}

export class ProviderAppError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(problems.join('; '));
    this.name = 'ProviderAppError';
  }
}

export class ProviderAppNotConfigured extends Error {
  constructor(
    readonly providerId: string,
    readonly missing: readonly string[],
  ) {
    super(
      `provider '${providerId}' has no complete app configuration (missing: ${missing.join(', ')}); ` +
        `set providers.${providerId}.* in the instance configuration or fill Admin → Provider apps`,
    );
    this.name = 'ProviderAppNotConfigured';
  }
}

export function providerAppKey(providerId: string, field: string): string {
  return `${PROVIDER_APP_KEY_PREFIX}.${providerId}.${field}`;
}

export function acceptUnverifiedKey(providerId: string): string {
  return `${PROVIDER_APP_FLAG_PREFIX}.${providerId}.${ACCEPT_UNVERIFIED_FLAG}`;
}

/** The file block as the snake_case record plugins read (`client_id`, `app_id`…). */
export function fileAppConfig(block: FileProviderAppConfig): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of PROVIDER_APP_FIELDS) {
    const value = block[PROVIDER_APP_FIELD_PROPERTY[field]];
    if (typeof value === 'string' && value.length > 0) out[field] = value;
  }
  return out;
}

export class ProviderAppsService {
  constructor(
    private readonly fromFile: ReadonlyMap<string, FileProviderAppConfig>,
    private readonly config: ConfigRepo,
    private readonly registry: PluginRegistry,
  ) {}

  /** True when the mounted configuration sets this provider: the Admin page cannot change it. */
  isReadOnly(providerId: string): boolean {
    return this.fromFile.has(providerId);
  }

  /** One entry per registered plugin, in registration order. */
  async list(): Promise<ProviderAppStatus[]> {
    return Promise.all(this.registry.ids.map((id) => this.status(id)));
  }

  async status(providerId: string): Promise<ProviderAppStatus> {
    const { plugin } = this.registry.require(providerId);
    const fields = appConfigFieldsOf(plugin.credential);
    const { source, values } = await this.read(providerId, fields);
    const missing = missingFields(fields, values);
    const visible: Record<string, string> = {};
    const secretsSet: string[] = [];
    for (const field of fields) {
      const value = values[field.name];
      if (!value) continue;
      if (field.secret) secretsSet.push(field.name);
      else visible[field.name] = value;
    }
    return {
      providerId,
      displayName: plugin.displayName,
      experimental: plugin.experimental === true,
      credentialKind: plugin.credential.kind,
      needsApp: fields.length > 0,
      fields,
      source: fields.length === 0 ? 'none' : source,
      configured: missing.length === 0,
      missing,
      values: visible,
      secretsSet,
      installVerification: await this.installVerification(providerId),
    };
  }

  /**
   * Whether the host can prove who performed an installation of this
   * provider's app, and what the operator decided when it cannot. `null` for
   * the kinds that install nothing.
   */
  async installVerification(providerId: string): Promise<InstallVerification | null> {
    const spec = this.registry.require(providerId).plugin.credential;
    if (spec.kind !== 'app-install') return null;
    if (spec.userVerification) return 'verified';
    const flag = await this.config.get(acceptUnverifiedKey(providerId));
    return flag === FLAG_ON ? 'unverified-accepted' : 'unverified-refused';
  }

  /**
   * The operator's explicit acceptance of installations nobody can verify.
   * Refused for a provider whose plugin verifies them: the flag never
   * weakens a verification that exists.
   */
  async setAcceptUnverifiedInstallations(
    providerId: string,
    accept: boolean,
  ): Promise<ProviderAppStatus> {
    const { plugin } = this.registry.require(providerId);
    const spec = plugin.credential;
    if (spec.kind !== 'app-install') {
      throw new ProviderAppError([`${plugin.displayName} is not connected by installing an app`]);
    }
    if (spec.userVerification) {
      throw new ProviderAppError([
        `${plugin.displayName} verifies every installation; there is nothing to accept`,
      ]);
    }
    if (accept) await this.config.set(acceptUnverifiedKey(providerId), FLAG_ON);
    else await this.config.delete(acceptUnverifiedKey(providerId));
    return this.status(providerId);
  }

  /**
   * The complete app configuration, secrets included — for the host's own
   * flows (OAuth client authentication, installation URL). Throws
   * `ProviderAppNotConfigured` naming the missing fields.
   */
  async hostAppConfig(providerId: string): Promise<ProviderAppConfig> {
    const { plugin } = this.registry.require(providerId);
    const fields = appConfigFieldsOf(plugin.credential);
    const { values } = await this.read(providerId, fields);
    const missing = missingFields(fields, values);
    if (missing.length > 0) throw new ProviderAppNotConfigured(providerId, missing);
    return values;
  }

  /**
   * What a plugin receives as `ctx.appConfig`: the same record minus the OAuth
   * client secret, which only the host uses (ADR plugin-contract-and-credential-spec
   * D2 "a plugin never sees the OAuth client secret") — for the `oauth2` flows
   * and for the user verification of an `app-install`. An `app-install` plugin
   * keeps every other field: it mints the installation tokens from the private key.
   */
  async pluginAppConfig(providerId: string): Promise<ProviderAppConfig> {
    const { plugin } = this.registry.require(providerId);
    if (appConfigFieldsOf(plugin.credential).length === 0) return {};
    const { [CLIENT_SECRET_FIELD]: _clientSecret, ...rest } = await this.hostAppConfig(providerId);
    return rest;
  }

  /**
   * Saves the fields of one provider. A blank secret keeps the stored one (the
   * form never echoes it); a blank optional field is removed.
   */
  async save(
    providerId: string,
    input: Readonly<Record<string, string>>,
  ): Promise<ProviderAppStatus> {
    const { plugin } = this.registry.require(providerId);
    const fields = appConfigFieldsOf(plugin.credential);
    if (fields.length === 0) {
      throw new ProviderAppError([
        `${plugin.displayName} needs no provider app: each user connects with their own credential`,
      ]);
    }
    if (this.isReadOnly(providerId)) {
      throw new ProviderAppError([
        `${plugin.displayName} is set by the mounted configuration (providers.${providerId}.*); edit it there`,
      ]);
    }
    const problems: string[] = [];
    const writes: ConfigWrite[] = [];
    for (const field of fields) {
      const key = providerAppKey(providerId, field.name);
      if (!APP_FIELD_NAME_PATTERN.test(field.name)) {
        problems.push(`${field.label}: the plugin declares an unusable field name`);
        continue;
      }
      const raw = (input[field.name] ?? '').trim();
      if (raw.length === 0) {
        const stored = await this.readStoredField(providerId, field);
        if (field.secret && stored) continue; // keep the stored secret
        if (isRequired(field)) problems.push(`${field.label} is required`);
        else writes.push({ kind: 'delete', key });
        continue;
      }
      if (field.pattern && !new RegExp(field.pattern).test(raw)) {
        problems.push(`${field.label} does not have the expected format`);
        continue;
      }
      writes.push(
        field.secret ? { kind: 'secret', key, plain: raw } : { kind: 'value', key, value: raw },
      );
    }
    if (problems.length > 0) throw new ProviderAppError(problems);

    // One transaction: never the client id of one app with the secret of another.
    await this.config.apply(writes);
    return this.status(providerId);
  }

  /**
   * Removes everything the Admin page stored for this provider, the
   * acceptance of unverified installations included (back to the default).
   */
  async clear(providerId: string): Promise<void> {
    const prefix = providerAppKey(providerId, '');
    const stored = (await this.config.keys()).filter((key) => key.startsWith(prefix));
    await this.config.apply(
      [...stored, acceptUnverifiedKey(providerId)].map((key) => ({ kind: 'delete', key })),
    );
  }

  private async read(
    providerId: string,
    fields: readonly CredentialField[],
  ): Promise<{ source: ProviderAppSource; values: Record<string, string> }> {
    const block = this.fromFile.get(providerId);
    if (block) return { source: 'file', values: fileAppConfig(block) };
    const values: Record<string, string> = {};
    for (const field of fields) {
      const value = await this.readStoredField(providerId, field);
      if (value) values[field.name] = value;
    }
    return { source: Object.keys(values).length > 0 ? 'store' : 'none', values };
  }

  private async readStoredField(
    providerId: string,
    field: CredentialField,
  ): Promise<string | null> {
    const key = providerAppKey(providerId, field.name);
    return field.secret ? this.config.getSecret(key) : this.config.get(key);
  }
}

function missingFields(
  fields: readonly CredentialField[],
  values: Readonly<Record<string, string>>,
): string[] {
  return fields.filter((f) => isRequired(f) && !values[f.name]).map((f) => f.name);
}
