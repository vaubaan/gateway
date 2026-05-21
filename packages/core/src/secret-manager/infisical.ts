/**
 * `infisical` SecretManager — built-in v1 plugin (spec §5.2). Stores the
 * sealed multi-recipient bundle (spec §4.3) inside an Infisical workspace
 * via the REST API.
 *
 * Mapping (spec §5.2 "Pas d'AccessScope union"):
 *
 *     (resourceId, accessKey)  →  Infisical (secretPath, secretKey)
 *                                  secretPath = `/<resourceId>`
 *                                  secretKey  = `<accessKey>`
 *
 * The secret VALUE is the **base64-encoded UTF-8 of
 * `JSON.stringify(sealedBlob)`**. Base64 because Infisical secrets are
 * stored as UTF-8 strings and we want to avoid any normalization or
 * whitespace artefact, plus a deterministic round-trip. The decoded
 * JSON must be a valid `SealedBlob` (`v: 1, recipients: [...]`) — any
 * other shape is rejected as corrupt.
 *
 * The Infisical workspace can only ever see this opaque blob; the
 * recipient list is plain JSON inside the blob (recipients are public,
 * ciphertexts are not — spec §4.4) but every recipient ciphertext is
 * still individually `crypto_box_seal`'d for its X25519 pubkey, so the
 * Infisical operator cannot read any cleartext.
 *
 * Bootstrap auth (spec §5.2 "Bootstrap auth Infisical"):
 *
 *     1. `secret_managers.auth_sealed_blob` holds the machine-identity
 *        `(clientId, clientSecret)` pair, sealed multi-recipient for
 *        org_admins ∪ runner_pk.
 *     2. The browser unseals the pair transitorily.
 *     3. Factory `createInfisicalSecretManager({ ..., auth })` is called
 *        with the unsealed pair in memory.
 *     4. The pair is **never persisted in cleartext** anywhere. It is
 *        forgotten when the SM instance is garbage-collected.
 */

import {
  createInfisicalClient,
  type InfisicalAuthCredentials,
  type InfisicalClient,
} from './infisical-client.js';
import type { SealedBlob, SecretManager } from './interface.js';

export interface InfisicalSecretManagerOptions {
  /** Endpoint base, e.g. `https://eu.infisical.com`. */
  readonly endpoint: string;
  /** Workspace UUID inside the org. */
  readonly workspaceId: string;
  /** Environment slug, defaults to `'prod'`. */
  readonly environment?: string;
  /** Machine-identity credentials (in-memory, never logged). */
  readonly auth: InfisicalAuthCredentials;
  /** Human-readable label, mirrors `secret_managers.name`. */
  readonly name: string;
  /** Custom fetch (tests). */
  readonly fetchImpl?: typeof fetch;
}

export class InfisicalSmError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'InfisicalSmError';
  }
}

function isSealedBlob(v: unknown): v is SealedBlob {
  if (v === null || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  if (o.v !== 1) return false;
  if (!Array.isArray(o.recipients)) return false;
  for (const r of o.recipients) {
    if (r === null || typeof r !== 'object') return false;
    const rr = r as Record<string, unknown>;
    if (typeof rr.fp !== 'string' || typeof rr.ct !== 'string') return false;
  }
  return true;
}

function encodeBlob(blob: SealedBlob): string {
  const utf8 = new TextEncoder().encode(JSON.stringify(blob));
  let bin = '';
  for (let i = 0; i < utf8.length; i++) bin += String.fromCharCode(utf8[i]!);
  return btoa(bin);
}

function decodeBlob(value: string): SealedBlob | null {
  let bin: string;
  try {
    bin = atob(value);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  try {
    const json: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return isSealedBlob(json) ? json : null;
  } catch {
    return null;
  }
}

function pathOf(resourceId: string): string {
  if (resourceId.length === 0) throw new InfisicalSmError('resourceId is empty', 'invalid_id');
  return `/${resourceId}`;
}

/**
 * Build an `infisical`-backed SecretManager. Accepts an injected
 * `InfisicalClient` for tests; otherwise constructs the default
 * REST-over-fetch client.
 */
export function createInfisicalSecretManager(
  opts: InfisicalSecretManagerOptions,
  injectedClient?: InfisicalClient,
): SecretManager {
  const client =
    injectedClient ??
    createInfisicalClient({
      endpoint: opts.endpoint,
      workspaceId: opts.workspaceId,
      environment: opts.environment ?? 'prod',
      auth: opts.auth,
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    });

  async function get(resourceId: string, accessKey: string): Promise<SealedBlob | null> {
    const secret = await client.getSecret(pathOf(resourceId), accessKey);
    if (!secret) return null;
    const decoded = decodeBlob(secret.secretValue);
    if (!decoded) {
      throw new InfisicalSmError(
        `infisical SM get(${resourceId},${accessKey}): payload is not a valid SealedBlobV1`,
        'corrupt_blob',
      );
    }
    return decoded;
  }

  async function list(resourceId: string): Promise<readonly string[]> {
    const secrets = await client.listSecrets(pathOf(resourceId));
    return secrets.map((s) => s.secretKey);
  }

  async function put(resourceId: string, accessKey: string, blob: SealedBlob): Promise<void> {
    if (!isSealedBlob(blob)) {
      throw new InfisicalSmError(
        'infisical SM put: blob is not a valid SealedBlobV1',
        'invalid_blob',
      );
    }
    await client.upsertSecret(pathOf(resourceId), accessKey, encodeBlob(blob));
  }

  async function revoke(resourceId: string, accessKey: string): Promise<void> {
    await client.deleteSecret(pathOf(resourceId), accessKey);
  }

  return {
    kind: 'infisical',
    name: opts.name,
    get,
    list,
    put,
    revoke,
  };
}
