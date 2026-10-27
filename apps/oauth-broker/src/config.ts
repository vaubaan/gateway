/**
 * The operator's configuration: one JSON document in OAUTH_BROKER_CONFIG.
 * Everything here is the operator's to decide and harmless to the tokens
 * (spec oauth-broker §4): where the public front is, which client id to use,
 * which instances are enrolled and where their browsers may be sent back.
 * Provider endpoints and scopes are not here (src/providers.ts).
 *
 * Confidential Space measures every environment variable, value included,
 * into the attestation the broker hands to anyone: so the enrollment is held
 * as digests and opaque ids only — the SHA-256 of each broker key and of each
 * return URL, never a key, a URL or a customer's name.
 */
import { type ProviderTable } from './providers.ts';

export interface Enrollment {
  readonly id: string;
  /** SHA-256 of the instance's broker key. The key itself is never configured. */
  readonly keyDigest: Buffer;
  /** Lowercase hex SHA-256 of each exact return URL on record. */
  readonly returnUrlDigests: ReadonlySet<string>;
}

export interface ProviderClient {
  readonly clientId: string;
  /** The name the platform adapter unseals the client secret by. */
  readonly secretName: string;
}

export interface BrokerConfig {
  /** Origin (and optional path) of the public HTTPS front for browsers. */
  readonly publicUrl: string;
  readonly apiPort: number;
  readonly httpPort: number;
  readonly clients: ReadonlyMap<string, ProviderClient>;
  readonly instances: readonly Enrollment[];
  /** The settings of the platform adapter, read by that adapter only. */
  readonly platform: Readonly<Record<string, unknown>>;
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

/** Opaque: random, never a name (it is readable from the attestation). */
const ID = /^[A-Za-z0-9_-]{8,64}$/;
const HEX_DIGEST = /^[0-9a-f]{64}$/;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** https, or http on a loopback host (development and tests). */
export function isAllowedUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username !== '' || url.password !== '' || url.hash !== '') return false;
  return url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.has(url.hostname));
}

function record(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ConfigError(`${where} must be an object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, where: string): string {
  if (typeof value !== 'string' || value === '') throw new ConfigError(`${where} must be a string`);
  return value;
}

function port(value: unknown, fallback: number, where: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65535) {
    throw new ConfigError(`${where} must be a port number`);
  }
  return value;
}

export function parseConfig(json: string, providers: ProviderTable): BrokerConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new ConfigError('OAUTH_BROKER_CONFIG is not JSON');
  }
  const root = record(raw, 'the configuration');

  const publicUrl = text(root.public_url, 'public_url').replace(/\/+$/, '');
  if (!isAllowedUrl(publicUrl) || new URL(publicUrl).search !== '') {
    throw new ConfigError('public_url must be an https URL without a query');
  }

  const clients = new Map<string, ProviderClient>();
  for (const [id, value] of Object.entries(record(root.providers, 'providers'))) {
    if (!providers.has(id)) throw new ConfigError(`providers.${id}: this broker does not serve it`);
    const entry = record(value, `providers.${id}`);
    const secretName =
      entry.client_secret_name === undefined
        ? `${id}-client-secret`
        : text(entry.client_secret_name, `providers.${id}.client_secret_name`);
    clients.set(id, { clientId: text(entry.client_id, `providers.${id}.client_id`), secretName });
  }
  if (clients.size === 0) throw new ConfigError('providers must name at least one provider');

  if (!Array.isArray(root.instances)) throw new ConfigError('instances must be a list');
  const seen = new Set<string>();
  const instances = root.instances.map((value: unknown, index): Enrollment => {
    const entry = record(value, `instances[${index}]`);
    const id = text(entry.id, `instances[${index}].id`);
    if (!ID.test(id) || seen.has(id))
      throw new ConfigError(`instances[${index}].id is invalid or repeated`);
    const digest = text(entry.key_sha256, `instances.${id}.key_sha256`);
    if (!HEX_DIGEST.test(digest) || seen.has(`key:${digest}`)) {
      throw new ConfigError(
        `instances.${id}.key_sha256 must be 64 lowercase hex characters, unique`,
      );
    }
    seen.add(id);
    seen.add(`key:${digest}`);
    const urls = entry.return_url_sha256;
    if (!Array.isArray(urls) || urls.length === 0) {
      throw new ConfigError(`instances.${id}.return_url_sha256 must be a non-empty list`);
    }
    const returnUrlDigests = new Set(
      urls.map((value: unknown) => {
        if (typeof value !== 'string' || !HEX_DIGEST.test(value)) {
          throw new ConfigError(`instances.${id}.return_url_sha256: 64 lowercase hex characters`);
        }
        return value;
      }),
    );
    return { id, keyDigest: Buffer.from(digest, 'hex'), returnUrlDigests };
  });

  return {
    publicUrl,
    apiPort: port(root.api_port, 8443, 'api_port'),
    httpPort: port(root.http_port, 8080, 'http_port'),
    clients,
    instances,
    platform: root.platform === undefined ? {} : record(root.platform, 'platform'),
  };
}
