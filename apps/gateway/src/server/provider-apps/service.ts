/**
 * The OAuth client of a service that connects that way (spec §4.3 "per
 * provider in use"; §7.1; ADR one-place-to-authorize-services-token-first):
 * the only thing a company declares at a service before a person connects,
 * and only for a service that offers no key a person can make (Gmail).
 *
 * Two sources and the precedence of the configuration loader: a
 * `providers.<id>` block of the mounted file / environment **wins** over what
 * an administrator saved from the service's connect page into
 * `instance_config`. A provider set by the file is read-only on the page.
 * Stored values live under `provider_apps.<id>.<field>`; secret fields are
 * sealed by the `Encryptor` (associated data
 * `instance_config:provider_apps.<id>.<field>`).
 *
 * Which fields exist comes from the plugin (`fields.ts`); this module holds
 * no provider list.
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

export type ProviderAppSource = 'file' | 'store' | 'none';

export interface ProviderAppStatus {
  readonly providerId: string;
  readonly displayName: string;
  readonly experimental: boolean;
  readonly credentialKind: CredentialSpec['kind'];
  /** False for `api-key` / `ssh-key` providers and for an `oauth2` client the gateway registers itself: nothing to declare, always connectable. */
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
        `set providers.${providerId}.* in the instance configuration or declare it on the service's connect page`,
    );
    this.name = 'ProviderAppNotConfigured';
  }
}

export function providerAppKey(providerId: string, field: string): string {
  return `${PROVIDER_APP_KEY_PREFIX}.${providerId}.${field}`;
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

  /** True when the mounted configuration sets this provider: the page cannot change it. */
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
    };
  }

  /**
   * The complete app configuration, secrets included — for the host's own
   * flows (OAuth client authentication). Throws
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
   * D2 "a plugin never sees the OAuth client secret"); `{}` for a plugin that
   * declares no OAuth client.
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
    // One transaction: never the client id of one app with the secret of another.
    await this.config.apply(await this.fieldWrites(providerId, input));
    return this.status(providerId);
  }

  /** The writes of one save: validated, a blank secret keeping the stored one. */
  private async fieldWrites(
    providerId: string,
    input: Readonly<Record<string, string>>,
  ): Promise<ConfigWrite[]> {
    const { plugin } = this.registry.require(providerId);
    const fields = appConfigFieldsOf(plugin.credential);
    if (fields.length === 0) {
      throw new ProviderAppError([
        plugin.credential.kind === 'oauth2'
          ? `${plugin.displayName} needs no OAuth client to declare: the gateway registers its own at ${plugin.displayName}`
          : `${plugin.displayName} needs no OAuth client: each person connects with their own key`,
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
      // nosemgrep: detect-non-literal-regexp -- pattern is a plugin's app-field declaration (code shipped in the image), not input
      if (field.pattern && !new RegExp(field.pattern).test(raw)) {
        problems.push(`${field.label} does not have the expected format`);
        continue;
      }
      writes.push(
        field.secret ? { kind: 'secret', key, plain: raw } : { kind: 'value', key, value: raw },
      );
    }
    if (problems.length > 0) throw new ProviderAppError(problems);
    return writes;
  }

  /** Removes everything the page stored for this provider; refused, like `save`, when the file sets it. */
  async clear(providerId: string): Promise<void> {
    const { plugin } = this.registry.require(providerId);
    if (this.isReadOnly(providerId)) {
      throw new ProviderAppError([
        `${plugin.displayName} is set by the mounted configuration (providers.${providerId}.*); edit it there`,
      ]);
    }
    const prefix = providerAppKey(providerId, '');
    const stored = (await this.config.keys()).filter((key) => key.startsWith(prefix));
    await this.config.apply(stored.map((key) => ({ kind: 'delete', key })));
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
