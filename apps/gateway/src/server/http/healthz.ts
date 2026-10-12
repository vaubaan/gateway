/**
 * `GET /healthz` — liveness for the container HEALTHCHECK and the reverse
 * proxy. Web-standard `Response` so any host (Next route handler today,
 * another server tomorrow) can mount it. Reveals build stamps and the store
 * kind, never configuration values.
 */
import type { GatewayRoot } from '../compose/root';

export interface HealthBody {
  readonly status: 'ok' | 'degraded' | 'unavailable';
  readonly version?: string;
  readonly commit?: string;
  readonly uptime_seconds?: number;
  readonly store?: { readonly kind: string; readonly status: 'ok' | 'error' };
  readonly reason?: string;
}

const HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

export async function healthResponse(root: GatewayRoot): Promise<Response> {
  let storeStatus: 'ok' | 'error' = 'ok';
  try {
    await root.store.ping();
  } catch (err) {
    storeStatus = 'error';
    root.logger.error('store ping failed', { err });
  }
  const body: HealthBody = {
    status: storeStatus === 'ok' ? 'ok' : 'degraded',
    version: root.build.version,
    commit: root.build.commit,
    uptime_seconds: Math.floor((Date.now() - root.startedAt.getTime()) / 1000),
    store: { kind: root.store.kind, status: storeStatus },
  };
  return new Response(JSON.stringify(body), {
    status: storeStatus === 'ok' ? 200 : 503,
    headers: HEADERS,
  });
}

/** When the root itself cannot be built (configuration error at runtime). */
export function unavailableResponse(): Response {
  const body: HealthBody = {
    status: 'unavailable',
    reason: 'composition root failed; see server log',
  };
  return new Response(JSON.stringify(body), { status: 503, headers: HEADERS });
}

/** Mounts `/healthz` on any host that provides the root lazily. */
export function healthHandler(getRoot: () => Promise<GatewayRoot>): () => Promise<Response> {
  return async () => {
    let root: GatewayRoot;
    try {
      root = await getRoot();
    } catch {
      return unavailableResponse();
    }
    return healthResponse(root);
  };
}
