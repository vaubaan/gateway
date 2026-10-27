/**
 * The two listeners (handbook oauth-broker, "Listeners"):
 *
 * - the gateway API, TLS with the in-memory identity, on its own port, meant
 *   for a TCP passthrough so that TLS ends in the enclave;
 * - plain HTTP for the browser callback and /healthz, meant to sit behind
 *   the operator's public HTTPS front.
 *
 * Each serves its own paths only. The access log names the route, never the
 * URL: the callback's query carries the provider's code.
 */
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { type Broker } from './broker.ts';
import { HttpError, sendError, sendJson } from './http-util.ts';
import { errorKind, type Logger } from './log.ts';
import { type TlsIdentity } from './tls-identity.ts';

const API_ROUTES = new Set(['/flows', '/grants/redeem', '/token', '/revoke', '/attest']);
const CALLBACK = /^\/oauth\/callback\/([a-z0-9-]{1,40})$/;

function limit(server: Server): Server {
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000; // a redeem waits for the provider (10 s at most)
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 50;
  return server;
}

/** Path and query of the request target; an unparsable target matches no route. */
function pathOf(req: IncomingMessage): { path: string; query: URLSearchParams } {
  try {
    const url = new URL(req.url ?? '/', 'http://broker.invalid');
    return { path: url.pathname, query: url.searchParams };
  } catch {
    return { path: '', query: new URLSearchParams() };
  }
}

/**
 * Runs a handler and logs one line: the route (a template, never the URL),
 * the status, the duration.
 */
async function answer(
  log: Logger,
  listener: string,
  route: string,
  req: IncomingMessage,
  res: ServerResponse,
  handle: () => Promise<void>,
): Promise<void> {
  const started = performance.now();
  try {
    await handle();
  } catch (error) {
    if (error instanceof HttpError) {
      sendError(res, error);
    } else {
      log.warn('unexpected_error', { listener, route, kind: errorKind(error) });
      if (!res.headersSent) sendError(res, new HttpError(500, 'server_error', 'the broker failed'));
      else res.destroy();
    }
  }
  log.info('request', {
    listener,
    method: req.method ?? '',
    route,
    status: res.statusCode,
    ms: Math.round(performance.now() - started),
  });
}

export function createApiServer(broker: Broker, tls: TlsIdentity, log: Logger): Server {
  const server = createHttpsServer(
    { key: tls.key, cert: tls.cert, minVersion: 'TLSv1.3' },
    (req, res) => {
      const { path } = pathOf(req);
      const route = API_ROUTES.has(path) ? path : 'unknown';
      void answer(log, 'api', route, req, res, async () => {
        if (route === 'unknown') throw new HttpError(404, 'not_found', 'no such call');
        if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'POST only');
        await broker.handleApi(req, res, path);
      });
    },
  );
  return limit(server);
}

export function createCallbackServer(broker: Broker, log: Logger): Server {
  const server = createHttpServer((req, res) => {
    const { path, query } = pathOf(req);
    const provider = CALLBACK.exec(path)?.[1];
    const route =
      path === '/healthz' ? path : provider !== undefined ? '/oauth/callback/:provider' : 'unknown';
    void answer(log, 'http', route, req, res, async () => {
      if (req.method !== 'GET') throw new HttpError(405, 'method_not_allowed', 'GET only');
      if (path === '/healthz') return sendJson(res, 200, { status: 'ok' });
      if (provider === undefined) throw new HttpError(404, 'not_found', 'no such page');
      broker.handleCallback(res, provider, query);
    });
  });
  return limit(server);
}
