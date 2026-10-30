/**
 * Google Confidential Space (ADR D7). Two things, both through what the
 * Confidential Space launcher gives the container:
 *
 * - attest: a custom attestation token from the launcher's TEE server,
 *   `POST http://localhost/v1/token` on the Unix socket
 *   /run/container_launcher/teeserver.sock, body {audience, token_type:
 *   "OIDC", nonces}. The answer is the JWT itself, signed by Google
 *   (issuer https://confidentialcomputing.googleapis.com), its `eat_nonce`
 *   claim carrying the nonces. Up to six nonces, 10 to 74 bytes each.
 * - unsealSecret: the launcher's default attestation token (`GET /v1/token`
 *   on the same socket, audience https://sts.googleapis.com) exchanged at
 *   Google's STS for a federated access token through the operator's Workload
 *   Identity Federation provider — whose attribute condition admits only the
 *   published image digest — then the secret read from Secret Manager.
 *
 * Verified against Google's documentation and the launcher's source
 * (handbook oauth-broker, "What was verified").
 */
import { request } from 'node:http';
import { type Fetch } from '../oauth-client.ts';
import {
  ATTESTATION_AUDIENCE,
  type Attestation,
  type PlatformAdapter,
  PlatformError,
} from './types.ts';

export const PLATFORM = 'gcp-confidential-space';
export const TEE_SERVER_SOCKET = '/run/container_launcher/teeserver.sock';
const STS_TOKEN_URL = 'https://sts.googleapis.com/v1/token';
const SECRET_MANAGER = 'https://secretmanager.googleapis.com/v1';
const TIMEOUT_MS = 15_000;
const MAX_ANSWER_BYTES = 256 * 1024;

const WIF_PROVIDER =
  /^\/\/iam\.googleapis\.com\/projects\/[0-9]+\/locations\/global\/workloadIdentityPools\/[a-z0-9-]+\/providers\/[a-z0-9-]+$/;
const PROJECT = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SECRET_NAME = /^[A-Za-z0-9_-]{1,255}$/;
const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export interface GcpSettings {
  /** //iam.googleapis.com/projects/<number>/locations/global/workloadIdentityPools/<pool>/providers/<provider> */
  readonly workloadIdentityProvider: string;
  /** The project that holds the secrets in Secret Manager. */
  readonly secretProject: string;
}

export function parseGcpSettings(value: unknown): GcpSettings {
  const settings =
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  const provider = settings.workload_identity_provider;
  const project = settings.secret_project;
  if (typeof provider !== 'string' || !WIF_PROVIDER.test(provider)) {
    throw new PlatformError(
      'platform.gcp-confidential-space.workload_identity_provider is missing or malformed',
    );
  }
  if (typeof project !== 'string' || !PROJECT.test(project)) {
    throw new PlatformError(
      'platform.gcp-confidential-space.secret_project is missing or malformed',
    );
  }
  return { workloadIdentityProvider: provider, secretProject: project };
}

/** One HTTP exchange with the launcher's TEE server, on its Unix socket. */
function teeServer(socketPath: string, method: 'GET' | 'POST', body?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath,
        host: 'localhost',
        path: '/v1/token',
        method,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        timeout: TIMEOUT_MS,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_ANSWER_BYTES)
            req.destroy(new PlatformError('TEE server answer too large'));
          else chunks.push(chunk);
        });
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8').trim();
          if (res.statusCode !== 200 || !JWT.test(text)) {
            reject(new PlatformError(`TEE server answered ${res.statusCode ?? 0}`));
          } else {
            resolve(text);
          }
        });
        res.on('error', () => reject(new PlatformError('TEE server answer broken')));
      },
    );
    req.on('timeout', () => req.destroy(new PlatformError('TEE server timed out')));
    req.on('error', (error) =>
      reject(error instanceof PlatformError ? error : new PlatformError('TEE server unreachable')),
    );
    req.end(body);
  });
}

async function json(
  fetchImpl: Fetch,
  url: string,
  init: RequestInit,
  step: string,
): Promise<Record<string, unknown>> {
  let response: Response;
  let text: string;
  try {
    response = await fetchImpl(url, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    text = await response.text();
  } catch {
    throw new PlatformError(`${step} could not be reached`);
  }
  if (response.status !== 200 || text.length > MAX_ANSWER_BYTES) {
    throw new PlatformError(`${step} answered ${response.status}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new PlatformError(`${step} answered no JSON`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new PlatformError(`${step} answered no object`);
  }
  return parsed as Record<string, unknown>;
}

export interface GcpAdapterOptions {
  readonly socketPath?: string;
  readonly fetch?: Fetch;
}

export function createGcpConfidentialSpaceAdapter(
  settings: GcpSettings,
  options: GcpAdapterOptions = {},
): PlatformAdapter {
  const socketPath = options.socketPath ?? TEE_SERVER_SOCKET;
  const fetchImpl = options.fetch ?? fetch;
  return {
    name: PLATFORM,
    attested: true,
    async attest(nonces): Promise<Attestation> {
      const body = JSON.stringify({ audience: ATTESTATION_AUDIENCE, token_type: 'OIDC', nonces });
      return { platform: PLATFORM, evidence: await teeServer(socketPath, 'POST', body) };
    },
    async unsealSecret(name): Promise<string> {
      if (!SECRET_NAME.test(name)) throw new PlatformError('secret name is malformed');
      const subjectToken = await teeServer(socketPath, 'GET');
      const sts = await json(
        fetchImpl,
        STS_TOKEN_URL,
        {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            audience: settings.workloadIdentityProvider,
            grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
            requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
            scope: 'https://www.googleapis.com/auth/cloud-platform',
            subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
            subject_token: subjectToken,
          }).toString(),
        },
        'STS',
      );
      if (typeof sts.access_token !== 'string')
        throw new PlatformError('STS answered no access token');
      const version = await json(
        fetchImpl,
        `${SECRET_MANAGER}/projects/${settings.secretProject}/secrets/${name}/versions/latest:access`,
        { method: 'GET', headers: { authorization: `Bearer ${sts.access_token}` } },
        'Secret Manager',
      );
      const payload = version.payload;
      const data =
        typeof payload === 'object' && payload !== null
          ? (payload as Record<string, unknown>).data
          : undefined;
      if (typeof data !== 'string') throw new PlatformError('Secret Manager answered no payload');
      const secret = Buffer.from(data, 'base64').toString('utf8').trim();
      if (secret === '') throw new PlatformError('the secret is empty');
      return secret;
    },
  };
}
