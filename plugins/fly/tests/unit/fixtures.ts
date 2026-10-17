/**
 * Shared fixtures of the `fly` tests : two apps of the `vaubaan` organization,
 * a credential, pinned images, and the answers an executor reads before the
 * request a test is about.
 */
import type { ExecuteContext, Resource } from '@vaubaan/plugin-sdk';
import type { MockRoute } from '@vaubaan/plugin-sdk/testing';

import { FLY_API_BASE } from '../../src/token.ts';
import {
  API_TOKEN_FIELD,
  IMAGE_PREFIXES_FIELD,
  ORG_SLUG_FIELD,
  PROVIDER_ID,
} from '../../src/identity.ts';

export const ORG = 'vaubaan';
export const DIGEST = 'a'.repeat(64);
export const IMAGE = `ghcr.io/vaubaan/gateway:1.4.0@sha256:${DIGEST}`;
export const OLD_IMAGE = `ghcr.io/vaubaan/gateway:1.3.0@sha256:${'b'.repeat(64)}`;
export const TOKEN = 'FlyV1 fm2_abcdefghijklmnopqrstuvwxyz0123456789';

export function app(name: string, env: 'prod' | 'staging', id: string): Resource {
  return {
    provider: PROVIDER_ID,
    ref: name,
    env,
    displayName: name,
    metadata: {
      app_id: id,
      org_slug: ORG,
      network: `${name}-net`,
      image_prefixes: 'ghcr.io/vaubaan/gateway',
    },
  };
}

/** A production app. */
export const acme = app('acme-gw', 'prod', 'app-acme');
/** A canary instance. */
export const canary = app('canary-gw', 'staging', 'app-canary');

export const credential = (fields: Record<string, string> = {}) => ({
  kind: 'api-key' as const,
  fields: {
    [API_TOKEN_FIELD]: TOKEN,
    [ORG_SLUG_FIELD]: ORG,
    [IMAGE_PREFIXES_FIELD]: '',
    ...fields,
  },
  metadata: {},
});

export function context(
  fetch: typeof globalThis.fetch,
  resources: readonly Resource[] = [acme],
  fields: Record<string, string> = {},
): ExecuteContext {
  return { credential: credential(fields), appConfig: {}, fetch, resources };
}

export const config = (image: string = IMAGE, mounts: unknown[] = []) => ({
  image,
  guest: { cpu_kind: 'shared', cpus: 1, memory_mb: 512 },
  mounts,
});

/** `GET /apps/<name>` answering the identity discovery recorded. */
export function appIdentityRoute(resources: readonly Resource[] = [acme, canary]): MockRoute {
  return {
    method: 'GET',
    url: (url) => /\/v1\/apps\/[^/?]+$/.test(url),
    respond: (call) => {
      const name = decodeURIComponent(call.url.split('/').pop() ?? '');
      const found = resources.find((r) => r.ref === name);
      return { id: found?.metadata?.app_id ?? 'unknown', name, organization: { slug: ORG } };
    },
  };
}

/** `GET /apps/<a>/machines/<m>` answering a machine with `machineConfig`. */
export function machineRoute(machineConfig: unknown = config(OLD_IMAGE)): MockRoute {
  return {
    method: 'GET',
    url: (url) => /\/machines\/[^/?]+$/.test(url),
    body: { id: 'm1', config: machineConfig, version: 'v1' },
  };
}

export const leaseRoutes: readonly MockRoute[] = [
  { method: 'POST', url: (url) => url.endsWith('/lease'), body: { nonce: 'n-1' } },
  { method: 'DELETE', url: (url) => url.endsWith('/lease'), body: {} },
];

export const API = FLY_API_BASE;
