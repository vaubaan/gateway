/**
 * Low-level Infisical REST client used by the `infisical` SecretManager.
 *
 * We model the **Machine Identity Universal Auth** flow (the GA-stable
 * Infisical machine auth as of 2025): the client exchanges a
 * `clientId` + `clientSecret` pair for a short-lived `accessToken`
 * (TTL ~7200s) and caches it until shortly before expiry. The pair is
 * sealed multi-recipient in `secret_managers.auth_sealed_blob`
 * (spec §5.2 "Bootstrap auth Infisical"); the browser unseals it
 * transitorily before invoking this client.
 *
 * Network shape (Infisical Cloud + self-hosted):
 *
 * - `POST {endpoint}/api/v1/auth/universal-auth/login`
 *     body: { clientId, clientSecret }
 *     200 : { accessToken, expiresIn, accessTokenMaxTTL, tokenType }
 *
 * - `GET  {endpoint}/api/v3/secrets/raw?workspaceId=&environment=&secretPath=`
 *     headers: Authorization: Bearer <accessToken>
 *     200 : { secrets: [{ secretKey, secretValue, ... }] }
 *
 * - `POST {endpoint}/api/v3/secrets/raw/{secretKey}`
 *     headers: Authorization: Bearer <accessToken>
 *     body: { workspaceId, environment, secretPath, secretValue, type }
 *
 * - `PATCH {endpoint}/api/v3/secrets/raw/{secretKey}`
 *     headers: Authorization: Bearer <accessToken>
 *     body: { workspaceId, environment, secretPath, secretValue, type }
 *
 * - `DELETE {endpoint}/api/v3/secrets/raw/{secretKey}`
 *     headers: Authorization: Bearer <accessToken>
 *     body: { workspaceId, environment, secretPath, type }
 *
 * ZK invariant: the client receives the `(clientId, clientSecret)` and
 * the `accessToken` only in memory. **Neither is logged**. We assert
 * this in unit tests by grepping the test capture buffer.
 *
 * Network injection: we accept an optional `fetch` impl so the tests
 * can wire a mock without monkey-patching the global. The default is
 * `globalThis.fetch` (Node 18+, browsers).
 */

export interface InfisicalAuthCredentials {
  /** Machine-identity client id (UUID). */
  readonly clientId: string;
  /** Machine-identity client secret (opaque). NEVER logged. */
  readonly clientSecret: string;
}

export interface InfisicalClientOptions {
  /** Endpoint base, e.g. `https://eu.infisical.com`. No trailing slash. */
  readonly endpoint: string;
  /** Workspace UUID inside the org. */
  readonly workspaceId: string;
  /** Environment slug ("prod", "dev"…) — defaults to `'prod'`. */
  readonly environment?: string;
  /** Auth credentials (in-memory only). */
  readonly auth: InfisicalAuthCredentials;
  /** Custom fetch (tests). Defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
  /** Skew applied to accessToken expiry, in seconds. Default 60. */
  readonly expirySkewSeconds?: number;
}

export interface InfisicalSecret {
  readonly secretKey: string;
  readonly secretValue: string;
}

export class InfisicalApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body?: string,
  ) {
    super(message);
    this.name = 'InfisicalApiError';
  }
}

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

export interface InfisicalClient {
  readonly endpoint: string;
  readonly workspaceId: string;
  readonly environment: string;
  listSecrets(secretPath: string): Promise<readonly InfisicalSecret[]>;
  getSecret(secretPath: string, secretKey: string): Promise<InfisicalSecret | null>;
  createSecret(secretPath: string, secretKey: string, secretValue: string): Promise<void>;
  updateSecret(secretPath: string, secretKey: string, secretValue: string): Promise<void>;
  upsertSecret(secretPath: string, secretKey: string, secretValue: string): Promise<void>;
  deleteSecret(secretPath: string, secretKey: string): Promise<void>;
}

export function createInfisicalClient(opts: InfisicalClientOptions): InfisicalClient {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('createInfisicalClient: no fetch impl available');
  }
  const endpoint = opts.endpoint.replace(/\/+$/, '');
  const workspaceId = opts.workspaceId;
  const environment = opts.environment ?? 'prod';
  const skew = (opts.expirySkewSeconds ?? 60) * 1000;
  const auth = opts.auth;

  let cache: CachedToken | null = null;

  async function getAccessToken(): Promise<string> {
    if (cache && cache.expiresAt - Date.now() > skew) return cache.accessToken;
    const res = await fetchImpl(`${endpoint}/api/v1/auth/universal-auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: auth.clientId, clientSecret: auth.clientSecret }),
    });
    if (!res.ok) {
      const text = await safeText(res);
      throw new InfisicalApiError('infisical auth failed', res.status, text);
    }
    const json = (await res.json()) as {
      accessToken?: string;
      expiresIn?: number;
    };
    if (!json.accessToken) {
      throw new InfisicalApiError('infisical auth: no accessToken in response', res.status);
    }
    cache = {
      accessToken: json.accessToken,
      expiresAt: Date.now() + (json.expiresIn ?? 7200) * 1000,
    };
    return cache.accessToken;
  }

  async function authHeaders(): Promise<Record<string, string>> {
    const token = await getAccessToken();
    return {
      Authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    };
  }

  async function listSecrets(secretPath: string): Promise<readonly InfisicalSecret[]> {
    const url = new URL(`${endpoint}/api/v3/secrets/raw`);
    url.searchParams.set('workspaceId', workspaceId);
    url.searchParams.set('environment', environment);
    url.searchParams.set('secretPath', secretPath);
    const res = await fetchImpl(url.toString(), { method: 'GET', headers: await authHeaders() });
    if (res.status === 404) return [];
    if (!res.ok) {
      throw new InfisicalApiError('infisical list failed', res.status, await safeText(res));
    }
    const json = (await res.json()) as { secrets?: InfisicalSecret[] };
    return json.secrets ?? [];
  }

  async function getSecret(secretPath: string, secretKey: string): Promise<InfisicalSecret | null> {
    const url = new URL(`${endpoint}/api/v3/secrets/raw/${encodeURIComponent(secretKey)}`);
    url.searchParams.set('workspaceId', workspaceId);
    url.searchParams.set('environment', environment);
    url.searchParams.set('secretPath', secretPath);
    const res = await fetchImpl(url.toString(), { method: 'GET', headers: await authHeaders() });
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new InfisicalApiError('infisical get failed', res.status, await safeText(res));
    }
    const json = (await res.json()) as { secret?: InfisicalSecret };
    return json.secret ?? null;
  }

  async function createSecret(
    secretPath: string,
    secretKey: string,
    secretValue: string,
  ): Promise<void> {
    const res = await fetchImpl(`${endpoint}/api/v3/secrets/raw/${encodeURIComponent(secretKey)}`, {
      method: 'POST',
      headers: await authHeaders(),
      body: JSON.stringify({
        workspaceId,
        environment,
        secretPath,
        secretValue,
        type: 'shared',
      }),
    });
    if (!res.ok) {
      throw new InfisicalApiError('infisical create failed', res.status, await safeText(res));
    }
  }

  async function updateSecret(
    secretPath: string,
    secretKey: string,
    secretValue: string,
  ): Promise<void> {
    const res = await fetchImpl(`${endpoint}/api/v3/secrets/raw/${encodeURIComponent(secretKey)}`, {
      method: 'PATCH',
      headers: await authHeaders(),
      body: JSON.stringify({
        workspaceId,
        environment,
        secretPath,
        secretValue,
        type: 'shared',
      }),
    });
    if (!res.ok) {
      throw new InfisicalApiError('infisical update failed', res.status, await safeText(res));
    }
  }

  async function upsertSecret(
    secretPath: string,
    secretKey: string,
    secretValue: string,
  ): Promise<void> {
    const existing = await getSecret(secretPath, secretKey);
    if (existing) {
      await updateSecret(secretPath, secretKey, secretValue);
    } else {
      await createSecret(secretPath, secretKey, secretValue);
    }
  }

  async function deleteSecret(secretPath: string, secretKey: string): Promise<void> {
    const res = await fetchImpl(`${endpoint}/api/v3/secrets/raw/${encodeURIComponent(secretKey)}`, {
      method: 'DELETE',
      headers: await authHeaders(),
      body: JSON.stringify({
        workspaceId,
        environment,
        secretPath,
        type: 'shared',
      }),
    });
    if (res.status === 404) return; // idempotent
    if (!res.ok) {
      throw new InfisicalApiError('infisical delete failed', res.status, await safeText(res));
    }
  }

  return {
    endpoint,
    workspaceId,
    environment,
    listSecrets,
    getSecret,
    createSecret,
    updateSecret,
    upsertSecret,
    deleteSecret,
  };
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}
