/**
 * `GET /healthz` — liveness for the container HEALTHCHECK and the reverse
 * proxy. Web-standard `Response` so any host (Next route handler today,
 * another server tomorrow) can mount it. Reveals build stamps and the store
 * kind, never configuration values. With a scheduled backup configured, the
 * `backup` object reports its latest run for an external checker (ADR
 * scheduled-encrypted-backup-to-object-storage, D8): no endpoint, bucket,
 * credential or URL.
 *
 * It takes the four things it reports on (`HealthDeps`), not the composition
 * root; the root satisfies the interface, so a host passes it as is.
 */
import type { BackupHealth } from '../backup';
import type { StoreLiveness } from '../compose/ports';
import type { Logger } from '../logging';

export interface HealthBody {
  readonly status: 'ok' | 'degraded' | 'unavailable' | 'setup';
  readonly version?: string;
  readonly commit?: string;
  readonly uptime_seconds?: number;
  readonly store?: { readonly kind: string; readonly status: 'ok' | 'error' };
  readonly backup?: BackupHealth;
  readonly reason?: string;
}

export interface HealthDeps {
  readonly store: Pick<StoreLiveness, 'kind' | 'ping'>;
  readonly logger: Pick<Logger, 'error'>;
  readonly build: { readonly version: string; readonly commit: string };
  readonly startedAt: Date;
  /** The scheduled backup's report; absent, the body has no `backup` object. */
  readonly backup?: { health(): Promise<BackupHealth> };
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
  let backup: BackupHealth | undefined;
  if (deps.backup && storeStatus === 'ok') {
    try {
      backup = await deps.backup.health();
    } catch (err) {
      deps.logger.error('backup report failed', { err });
    }
  }
  const body: HealthBody = {
    status: storeStatus === 'ok' ? 'ok' : 'degraded',
    version: deps.build.version,
    commit: deps.build.commit,
    uptime_seconds: Math.floor((now.getTime() - deps.startedAt.getTime()) / MS_PER_SECOND),
    store: { kind: deps.store.kind, status: storeStatus },
    ...(backup ? { backup } : {}),
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

/**
 * Setup mode: the process is alive and serves the setup page, nothing else. 200,
 * so the platform's health check keeps the container up while the key is awaited.
 */
export function setupResponse(deps: Omit<HealthDeps, 'store' | 'logger'>): Response {
  const now = (deps.now ?? (() => new Date()))();
  const body: HealthBody = {
    status: 'setup',
    version: deps.build.version,
    commit: deps.build.commit,
    uptime_seconds: Math.floor((now.getTime() - deps.startedAt.getTime()) / MS_PER_SECOND),
    reason: 'waiting for the master key on the setup page',
  };
  return new Response(JSON.stringify(body), { status: 200, headers: HEADERS });
}

/** Mounts `/healthz` on any host that provides its dependencies lazily (the root satisfies them). */
export function healthHandler(getDeps: () => Promise<HealthDeps>): () => Promise<Response> {
  return async () => {
    let deps: HealthDeps;
    try {
      deps = await getDeps();
    } catch {
      // expected: the root did not build; the boot path reports why, the probe answers unavailable
      return unavailableResponse();
    }
    return healthResponse(deps);
  };
}
