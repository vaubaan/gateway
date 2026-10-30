/**
 * The listeners (handbook oauth-broker, "Listeners"). In an enclave, two:
 *
 * - the gateway API, TLS with the in-memory identity, on its own port, meant
 *   for a TCP passthrough so that TLS ends in the enclave;
 * - plain HTTP for the browser callback and /healthz, meant to sit behind
 *   the operator's public HTTPS front.
 *
 * Without an enclave (platform `unattested`), one plain HTTP listener serves
 * every path, behind the platform's TLS: there is no key for an attestation
 * to name, so ending TLS in the process would prove nothing.
 *
 * Each listener serves its own paths only. The access log names the route,
 * never the URL: the callback's query carries the provider's code.
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
/** Per listener; beyond, new connections are dropped until some close. */
const MAX_CONNECTIONS = 1024;
const CALLBACK = /^\/oauth\/callback\/([a-z0-9-]{1,40})$/;

function limit(server: Server): Server {
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000; // a redeem waits for the provider (10 s at most)
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 50;
  server.maxConnections = MAX_CONNECTIONS;
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

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

/** The gateway API's paths, POST only. */
function apiHandler(broker: Broker, log: Logger, listener: string): Handler {
  return (req, res) => {
    const { path } = pathOf(req);
    const route = API_ROUTES.has(path) ? path : 'unknown';
    void answer(log, listener, route, req, res, async () => {
      if (route === 'unknown') throw new HttpError(404, 'not_found', 'no such call');
      if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'POST only');
      await broker.handleApi(req, res, path);
    });
  };
}

/** The browser callback and /healthz, GET only. */
function browserHandler(broker: Broker, log: Logger, listener: string): Handler {
  return (req, res) => {
    const { path, query } = pathOf(req);
    const provider = CALLBACK.exec(path)?.[1];
    const route =
      path === '/healthz' ? path : provider !== undefined ? '/oauth/callback/:provider' : 'unknown';
    void answer(log, listener, route, req, res, async () => {
      if (req.method !== 'GET') throw new HttpError(405, 'method_not_allowed', 'GET only');
      if (path === '/healthz') return sendJson(res, 200, { status: 'ok' });
      if (provider === undefined) throw new HttpError(404, 'not_found', 'no such page');
      broker.handleCallback(res, provider, query);
    });
  };
}

export function createApiServer(broker: Broker, tls: TlsIdentity, log: Logger): Server {
  const server = createHttpsServer(
    { key: tls.key, cert: tls.cert, minVersion: 'TLSv1.3', handshakeTimeout: 10_000 },
    apiHandler(broker, log, 'api'),
  );
  return limit(server);
}

export function createCallbackServer(broker: Broker, log: Logger): Server {
  return limit(createHttpServer(browserHandler(broker, log, 'http')));
}

/** Without an enclave: the API's paths and the browser's, on one plain HTTP listener. */
export function createSingleServer(broker: Broker, log: Logger): Server {
  const api = apiHandler(broker, log, 'http');
  const browser = browserHandler(broker, log, 'http');
  return limit(
    createHttpServer((req, res) => {
      (API_ROUTES.has(pathOf(req).path) ? api : browser)(req, res);
    }),
  );
}
