/**
 * The demo instance: the real application on `http://localhost:<port>`, with
 * a simulated identity provider and simulated providers, for a human with a
 * normal browser (handbook demo-mode).
 *
 * One process, built like the browser tests' ephemeral instance
 * (`tests/e2e/v5/ephemeral-instance.ts`):
 *
 *   - the real composition root, published on `globalThis` as production does,
 *     so the built Next application served below runs on it;
 *   - its configuration assembled here, in memory: a master key and a GitHub
 *     App key pair generated per run, a throwaway SQLite file under the OS
 *     temp directory, the three demo people, telemetry off. The public URL is
 *     `http://localhost:<port>`. The configuration loader only accepts https
 *     and is left as it is: the demo loads a placeholder through it and sets
 *     the URL on the typed result, as a test does;
 *   - the demo IdP (`demo-idp.ts`)
 *     served by the same listener under `/__demo/`, which exists nowhere but
 *     in this file: a normally composed root has no such route;
 *   - every provider request answered by `providers.ts`; the collector and
 *     the client-document fetchers refuse outright.
 *
 * The listener binds 127.0.0.1 only.
 */
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRegistry, type ProviderPlugin } from '@vaubaan/plugin-sdk';

import type { CustomFetch } from '../../src/server/auth/relying-party';
import type { RateLimiter } from '../../src/server/compose/ports';
import { getRoot, resetRoot, type GatewayRoot } from '../../src/server/compose/root';
import { SHIPPED_PLUGINS } from '../../src/server/compose/shipped-plugins';
import { loadInstanceConfig, type LoadedConfig } from '../../src/server/config';
import { MASTER_KEY_BYTES } from '../../src/server/config/load';
import { SlidingWindowRateLimiter } from '../../src/server/rate-limit';
import { DEMO_IDP_PATH, DemoIdp } from './demo-idp';
import { ALICE } from './people';
import { createDemoProviders, type DemoProviders } from './providers';
import { seedDemo, type SeedSummary } from './seed';

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const LOOPBACK = '127.0.0.1';
/** Everything the demo serves itself lives under this prefix. */
export const DEMO_PREFIX = '/__demo';

type NextFactory = (options: { dev: boolean; dir: string; hostname: string; port: number }) => {
  prepare(): Promise<void>;
  getRequestHandler(): (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  close?(): Promise<void>;
};

export interface DemoOptions {
  /** Port to listen on; `0` lets the system pick one. */
  readonly port: number;
  /** Keep the SQLite file and the log after `close()` (`DEMO_KEEP=1`). */
  readonly keepStore?: boolean;
  /** Progress lines while the instance starts. */
  readonly progress?: (line: string) => void;
}

export interface RunningDemo {
  /** `http://localhost:<port>`: the instance's public URL. */
  readonly origin: string;
  readonly port: number;
  /** Directory holding the SQLite file and the instance log. */
  readonly directory: string;
  readonly storePath: string;
  readonly logPath: string;
  readonly kept: boolean;
  readonly root: GatewayRoot;
  readonly providers: DemoProviders;
  readonly seeded: SeedSummary;
  close(): Promise<void>;
}

/** Where `next build` writes the production build the demo serves. */
export const BUILD_DIR = resolve(APP_DIR, '.next');

/** True when `apps/gateway/.next` holds a production build to serve. */
export function hasBuild(): boolean {
  return existsSync(resolve(BUILD_DIR, 'BUILD_ID'));
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolvePort, reject) => {
    server.once('error', reject);
    server.listen(port, LOOPBACK, () => {
      server.off('error', reject);
      resolvePort((server.address() as AddressInfo).port);
    });
  });
}

/**
 * The shipped plugins, with one difference that keeps this process on the
 * machine: the SSH plugin is left out, because its calls do not go through
 * `fetch` but open connections to whatever host the user names, which nothing
 * here simulates. Everything else of every plugin — tools, catalog,
 * classifier, the check of a pasted token — is the shipped code.
 */
function demoPlugins(): ProviderPlugin[] {
  return SHIPPED_PLUGINS.filter((plugin) => plugin.credential.kind !== 'ssh-key');
}

/** The demo configuration, typed by the real loader, then pointed at the local origin. */
function demoConfig(origin: string, storePath: string, idp: DemoIdp) {
  return (): LoadedConfig => {
    const loaded = loadInstanceConfig({
      env: {
        // Placeholder: the loader refuses anything but https, and stays that way.
        VAUBAAN_PUBLIC_URL: 'https://demo.invalid',
        VAUBAAN_STORE_PATH: storePath,
        VAUBAAN_MASTER_KEY: randomBytes(MASTER_KEY_BYTES).toString('base64'),
        // Never printed: the demo signs in through its IdP only.
        VAUBAAN_BOOTSTRAP_TOKEN: randomBytes(32).toString('hex'),
        VAUBAAN_ADMIN_EMAILS: ALICE.email,
        VAUBAAN_TELEMETRY_ENABLED: 'false',
      },
    });
    return {
      configFile: null,
      secretEnvNames: [],
      masterKeyGenerated: false,
      config: {
        ...loaded.config,
        publicUrl: new URL(origin),
        idp: {
          issuer: idp.publicIssuer,
          clientId: idp.clientId,
          clientSecret: idp.clientSecret,
          claims: { sub: 'sub', email: 'email', groups: 'groups' },
          allowedEmailDomains: [],
          invitationOnly: false,
        },
      },
    };
  };
}

/**
 * The surface rate limits of the real instance, lifted while the seed runs:
 * the seed connects four providers in Alice's name within a second, and the
 * first minute of the tour should not find her connect allowance spent.
 */
class SeedAwareRateLimiter implements RateLimiter {
  seeding = true;
  private readonly inner = new SlidingWindowRateLimiter();

  async take(key: string, limit: number, windowMs: number) {
    if (this.seeding) return { allowed: true, remaining: limit, retryAfterMs: 0 };
    return this.inner.take(key, limit, windowMs);
  }
}

function refuseOutbound(what: string): typeof fetch {
  return async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    throw new Error(`demo mode: ${what} is disabled — refused ${url}`);
  };
}

export async function startDemo(options: DemoOptions): Promise<RunningDemo> {
  const progress = options.progress ?? (() => undefined);
  if (!hasBuild()) {
    throw new Error(
      `no production build under ${APP_DIR}/.next — run "npm run build --workspace @vaubaan/gateway-app" first ("npm run demo" does)`,
    );
  }
  const directory = mkdtempSync(join(tmpdir(), 'vaubaan-demo-'));
  const storePath = join(directory, 'gateway.db');
  const logPath = join(directory, 'gateway.log');
  const kept = options.keepStore === true;

  // The handler is installed in two steps: the demo's own pages answer as soon
  // as the port is open (the relying party discovers the IdP during the seed),
  // the application once Next is ready.
  let serve: ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | null = null;
  let application: ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | null = null;
  const server = createServer((req, res) => {
    void (async () => {
      if (!serve) {
        res.writeHead(503, { 'Content-Type': 'text/plain', 'Retry-After': '2' });
        res.end('The demo is starting.\n');
        return;
      }
      await serve(req, res);
    })().catch((err: unknown) => {
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(`${err instanceof Error ? err.message : String(err)}\n`);
    });
  });
  const port = await listen(server, options.port);
  const origin = `http://localhost:${port}`;

  const providers = createDemoProviders({
    onUnmatched: (error) => process.stderr.write(`\n${error.message}\n`),
  });
  const idp = new DemoIdp(origin);
  serve = async (req, res) => {
    const url = new URL(req.url ?? '/', origin);
    if (url.pathname.startsWith(`${DEMO_IDP_PATH}/`)) return idp.handle(req, res, url);
    if (url.pathname.startsWith(`${DEMO_PREFIX}/`) || !application) {
      res.writeHead(application ? 404 : 503, { 'Content-Type': 'text/plain' });
      res.end(application ? 'Not a page of the demo.\n' : 'The demo is starting.\n');
      return;
    }
    await application(req, res);
  };

  let root: GatewayRoot | null = null;
  const cleanUp = async (): Promise<void> => {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    if (root) await resetRoot();
    if (!kept) rmSync(directory, { recursive: true, force: true });
  };

  try {
    progress('building the composition root');
    const rateLimiter = new SeedAwareRateLimiter();
    // The relying party reaches the IdP on the listener itself, over HTTP. It
    // dials the loopback address: `localhost` may resolve to ::1 first, where
    // nothing listens.
    const toLoopback: CustomFetch = (url, init) =>
      fetch(url.replace(origin, `http://${LOOPBACK}:${port}`), init as RequestInit);
    root = await getRoot({
      loadConfig: demoConfig(origin, storePath, idp),
      buildRegistry: async () => createRegistry(demoPlugins()),
      oidc: { fetch: toLoopback, allowInsecureIssuer: true },
      providerFetch: providers.fetch,
      telemetryFetch: refuseOutbound('telemetry'),
      clientDocumentFetch: async (url) => {
        throw new Error(`demo mode: client metadata documents are disabled — refused ${url.href}`);
      },
      rateLimiter,
      // The instance log goes to a file next to the store, not over the tour.
      logWrite: (_level, line) => appendFileSync(logPath, line),
    });
    if (root.config.publicUrl.origin !== origin) {
      throw new Error('another composition root already exists in this process');
    }

    progress('seeding people, accounts, missions and calls');
    const seeded = await seedDemo({ root, idp, providers });
    rateLimiter.seeding = false;

    progress('starting the web application');
    // Next reads NODE_ENV when it loads: the built application is a production build.
    (process.env as Record<string, string>).NODE_ENV = 'production';
    const loaded = (await import('next')) as unknown as { default: unknown };
    const next = (
      typeof loaded.default === 'function'
        ? loaded.default
        : (loaded.default as { default: unknown }).default
    ) as NextFactory;
    const app = next({ dev: false, dir: APP_DIR, hostname: 'localhost', port });
    await app.prepare();
    application = app.getRequestHandler();

    const running: RunningDemo = {
      origin,
      port,
      directory,
      storePath,
      logPath,
      kept,
      root,
      providers,
      seeded,
      async close() {
        application = null;
        await app.close?.();
        await cleanUp();
      },
    };
    return running;
  } catch (err) {
    await cleanUp();
    throw err;
  }
}
