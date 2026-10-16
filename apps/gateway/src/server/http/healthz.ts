/**
 * `GET /healthz` — liveness for the container HEALTHCHECK and the reverse
 * proxy. Web-standard `Response` so any host (Next route handler today,
 * another server tomorrow) can mount it. Reveals build stamps and the store
 * kind, never configuration values.
 *
 * It takes the four things it reports on (`HealthDeps`), not the composition
 * root; the root satisfies the interface, so a host passes it as is.
 */
import type { StoreLiveness } from '../compose/ports';
import type { Logger } from '../logging';

export interface HealthBody {
  readonly status: 'ok' | 'degraded' | 'unavailable';
  readonly version?: string;
  readonly commit?: string;
  readonly uptime_seconds?: number;
  readonly store?: { readonly kind: string; readonly status: 'ok' | 'error' };
  readonly reason?: string;
}

export interface HealthDeps {
  readonly store: Pick<StoreLiveness, 'kind' | 'ping'>;
  readonly logger: Pick<Logger, 'error'>;
  readonly build: { readonly version: string; readonly commit: string };
  readonly startedAt: Date;
  /** Defaults to the wall clock; tests inject a fixed instant. */
  readonly now?: () => Date;
}

const HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const MS_PER_SECOND = 1000;

export async function healthResponse(deps: HealthDeps): Promise<Response> {
  let storeStatus: 'ok' | 'error' = 'ok';
  try {
    await deps.store.ping();
  } catch (err) {
    storeStatus = 'error';
    deps.logger.error('store ping failed', { err });
  }
  const now = (deps.now ?? (() => new Date()))();
  const body: HealthBody = {
    status: storeStatus === 'ok' ? 'ok' : 'degraded',
    version: deps.build.version,
    commit: deps.build.commit,
    uptime_seconds: Math.floor((now.getTime() - deps.startedAt.getTime()) / MS_PER_SECOND),
    store: { kind: deps.store.kind, status: storeStatus },
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

/** Mounts `/healthz` on any host that provides its dependencies lazily (the root satisfies them). */
export function healthHandler(getDeps: () => Promise<HealthDeps>): () => Promise<Response> {
  return async () => {
    let deps: HealthDeps;
    try {
      deps = await getDeps();
    } catch {
      return unavailableResponse();
    }
    return healthResponse(deps);
  };
}
