/**
 * Launcher of an ephemeral gateway instance for the browser tests (spec §10
 * "integration on an ephemeral instance with embedded store and simulated
 * IdP"). One process:
 *
 *   - the real composition root, built here with the `:memory:` store, the
 *     plugins the image ships, P1.1's in-process `FakeIdp` as the relying
 *     party's `fetch` and a mocked GitHub as `RootDeps.providerFetch`, and
 *     published on `globalThis` exactly as production does;
 *   - the server that ships: the standalone `server.js` of the build
 *     (`.next/standalone/apps/gateway/server.js`), started in this process
 *     the way `deploy/docker/Dockerfile` starts it — the static assets and
 *     `public/` copied beside it, `PORT` and `HOSTNAME` in the environment.
 *     It is not wrapped: it owns the app's port, and its `getRoot()` returns
 *     the promise already on `globalThis`. A file the build failed to trace
 *     into the standalone tree therefore fails the suite;
 *   - nothing of its own between a request and the root: the executor's calls
 *     of every spec arrive over HTTP on `/mcp` and run through
 *     `root.execution` (the door, the pipeline, `root.budget`), exactly as an
 *     agent's do;
 *   - Ada's connections seeded straight through the repositories, her GitHub
 *     one carrying an installation of the mocked GitHub;
 *   - control endpoints under `/__e2e`, which exist only in this file and
 *     listen on a port of their own, the one after the app's (`controlPort`,
 *     `instance.ts`), since the app's port is the standalone server's: the
 *     consent screens the browser cannot reach (the simulated IdP's, the
 *     mocked GitHub's installation page), who signs in next, a token check
 *     through `MissionService.verifyToken`, `small-mission` (a mission of Ada
 *     with a two-action quota and its token), `developer-mission` (a mission
 *     issued from the GitHub plugin's `developer` preset as shipped, for a
 *     user of their own, and its token), `share-scenario` (an owner with a
 *     GitHub connection of their own, a beneficiary and the operator, for
 *     the share spec), `upstream` (what the mocked provider
 *     received) and `seed-day` — the one fixture written below the door: a
 *     day of calls recorded through `root.budget` and the audit writer, with
 *     gated and exhausted risks, for the audit pages.
 *
 * Run by Playwright's `webServer` (see `playwright.config.ts` next to this
 * file) after `next build`, with `tsx`, from the repository's sources: it
 * needs nothing of `tests/` inside the standalone tree, and the build keeps
 * the test files out of it (`outputFileTracingExcludes`, `next.config.ts`).
 * Never part of the image.
 */
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { cpSync, existsSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { githubCredential } from '@vaubaan/plugin-github';
import { mockFetch, type MockFetch } from '@vaubaan/plugin-sdk/testing';

import { getRoot, type GatewayRoot } from '../../../src/server/compose/root';
import { serializeSecret } from '../../../src/server/connections';
import { seedConnection } from '../../../src/server/missions/testing';
import type { UserRecord } from '../../../src/server/store/types';
import { seedDayOfWork, type AuditRig } from '../../integration/audit/support';
import { FakeIdp } from '../../integration/auth/fake-idp';
import { seedInstance, testRootDeps } from '../../integration/missions/support';
import {
  CONTROL_PREFIX,
  controlPort,
  E2E_APPROVER_USER,
  E2E_AUDIT_USER,
  E2E_OPERATOR,
  E2E_SHARE_OWNER,
  E2E_SHARE_TARGET,
  IDP_ISSUER,
  instancePort,
  MOCK_GITHUB,
  PUBLIC_URL,
} from './instance';

const CLIENT = { clientId: 'vaubaan-gateway-e2e', clientSecret: 'e2e-client-secret' };
const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
/** Where the build writes the app in the standalone tree (the tracing root is the repository). */
const STANDALONE_APP = resolve(APP_DIR, '.next/standalone/apps/gateway');
/** What the image runs: `CMD ["node", "apps/gateway/server.js"]`. */
const STANDALONE_SERVER = resolve(STANDALONE_APP, 'server.js');
/**
 * How long the two listeners keep an idle connection open: longer than a test
 * may last (`playwright.config.ts`, 120 s).
 *
 * The browser's requests are forwarded by Playwright's own HTTP client
 * (`route.fetch`), which keeps its connections alive and reuses them, and does
 * not retry a reset unless asked to. A Node server closes an idle connection
 * after 5 s by default. A test that leaves the page alone for about that long —
 * a form being filled, a hand changing — can then send its next request on a
 * connection the server is closing at that instant: `route.fetch: socket hang
 * up`, once in a great many runs. With this, the server never closes a
 * connection a running test may still reuse.
 */
const IDLE_SOCKET_MS = 180_000;
const LOOPBACK = '127.0.0.1';

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/* ------------------------------------------------------------------------ */
/* The mocked GitHub                                                         */
/* ------------------------------------------------------------------------ */

const random = (bytes = 24): string => randomBytes(bytes).toString('hex');

/**
 * The company's GitHub App, as the operator would mount it
 * (`providers.github.*`). The key pair and the secrets are generated per run:
 * no credential of this file exists anywhere else.
 */
const GITHUB_APP = {
  appId: '123',
  slug: 'acme-gateway',
  clientId: 'Iv1.e2e0000000000000',
  clientSecret: random(),
  privateKey: generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  }).privateKey,
};
/** What GitHub hands the gateway; neither may ever reach a browser or an executor. */
const INSTALLATION_TOKEN = `ghs_${random()}`;
const USER_TOKEN = `ghu_${random()}`;

const verification = githubCredential.userVerification;
if (!verification) throw new Error('the github plugin no longer verifies installations');
/** Every endpoint below is read off the plugin's own credential spec. */
const GITHUB_API = new URL(verification.installationsUrl).origin;
const GITHUB_INSTALL_PAGE = githubCredential.installUrl({ app_slug: GITHUB_APP.slug });

function githubEnv(): Record<string, string> {
  return {
    VAUBAAN_PROVIDER_GITHUB_APP_ID: GITHUB_APP.appId,
    VAUBAAN_PROVIDER_GITHUB_APP_SLUG: GITHUB_APP.slug,
    VAUBAAN_PROVIDER_GITHUB_PRIVATE_KEY: GITHUB_APP.privateKey,
    VAUBAAN_PROVIDER_GITHUB_CLIENT_ID: GITHUB_APP.clientId,
    VAUBAAN_PROVIDER_GITHUB_CLIENT_SECRET: GITHUB_APP.clientSecret,
  };
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * GitHub's side of the connect flow and of the calls: the token endpoint of
 * the user authorization, the installations that user can reach, the
 * installation token, the repositories of the installation, two read
 * endpoints and the file write. Any other request rejects (`mockFetch`):
 * nothing reaches a network.
 */
function mockedGithub(): MockFetch {
  const api = escapeRegExp(GITHUB_API);
  return mockFetch([
    {
      method: 'POST',
      url: verification!.tokenUrl,
      body: { access_token: USER_TOKEN, token_type: 'bearer' },
    },
    {
      method: 'GET',
      url: (url) => url.startsWith(`${verification!.installationsUrl}?`),
      respond: (call) => ({
        installations:
          new URL(call.url).searchParams.get('page') === '1'
            ? [{ id: Number(MOCK_GITHUB.installationId) }]
            : [],
      }),
    },
    {
      method: 'POST',
      url: `${GITHUB_API}/app/installations/${MOCK_GITHUB.installationId}/access_tokens`,
      status: 201,
      respond: () => ({
        token: INSTALLATION_TOKEN,
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        permissions: { contents: 'read', metadata: 'read' },
      }),
    },
    {
      method: 'GET',
      url: (url) => url.startsWith(`${GITHUB_API}/installation/repositories?`),
      body: {
        total_count: MOCK_GITHUB.repositories.length,
        repositories: MOCK_GITHUB.repositories.map((fullName) => ({
          full_name: fullName,
          default_branch: 'main',
          private: true,
          archived: false,
        })),
      },
    },
    {
      method: 'GET',
      url: new RegExp(`^${api}/repos/[^/]+/[^/]+/branches(\\?|$)`),
      body: MOCK_GITHUB.branches,
    },
    {
      method: 'GET',
      url: new RegExp(`^${api}/repos/[^/]+/[^/]+/contents/`),
      respond: (call) => {
        const path = new URL(call.url).pathname.split('/contents/')[1] ?? '';
        return {
          type: 'file',
          name: path.split('/').pop(),
          path,
          encoding: 'base64',
          content: Buffer.from('# mocked file\n').toString('base64'),
        };
      },
    },
    {
      // A file created or updated on a branch (`github__create_or_update_file`).
      method: 'PUT',
      url: new RegExp(`^${api}/repos/[^/]+/[^/]+/contents/`),
      status: 201,
      respond: (call) => ({
        content: {
          path: decodeURIComponent(new URL(call.url).pathname.split('/contents/')[1] ?? ''),
        },
        commit: { sha: 'c0ffee0000000000000000000000000000000000' },
      }),
    },
  ]);
}

/**
 * The installation page of the mocked GitHub: the user "installs the App and
 * authorizes", and GitHub sends the browser back with the installation id, a
 * single-use code and the `state` the gateway gave.
 */
function githubInstallCallback(pageUrl: URL): string | null {
  if (`${pageUrl.origin}${pageUrl.pathname}` !== GITHUB_INSTALL_PAGE) return null;
  const callback = new URL(`${PUBLIC_URL}/connections/callback/github`);
  callback.searchParams.set(githubCredential.installationIdParam, MOCK_GITHUB.installationId);
  callback.searchParams.set('setup_action', 'install');
  callback.searchParams.set(verification!.codeParam, random(10));
  const state = pageUrl.searchParams.get('state');
  if (state) callback.searchParams.set('state', state);
  return callback.href;
}

/* ------------------------------------------------------------------------ */
/* Fixtures                                                                  */
/* ------------------------------------------------------------------------ */

/** The risk the executor of "exhaust and claim" spends, and its quota. */
const SMALL_RISK = 'github.read-code';
const SMALL_QUOTA = 2;

/** A mission of `creator` on their GitHub connection with a two-action quota, and its token. */
async function issueSmallMission(
  root: GatewayRoot,
  creator: UserRecord,
  githubConnectionId: string,
  name: string,
): Promise<{ mission_id: string; token: string }> {
  const issued = await root.missions.service.issue(creator, {
    name,
    connections: [
      {
        connection_id: githubConnectionId,
        policy: [
          {
            risk_id: SMALL_RISK,
            quota: SMALL_QUOTA,
            rate_limit: { max: 60, window_seconds: 60 },
            gate: 'auto',
          },
          {
            risk_id: 'github.read-meta',
            quota: 10,
            rate_limit: { max: 60, window_seconds: 60 },
            gate: 'auto',
          },
        ],
      },
    ],
    period: { kind: 'recurring', length_seconds: 86_400 },
    expires_at: null,
  });
  if (!issued.ok) throw new Error(`mission "${name}" was not issued`);
  return { mission_id: issued.mission.id, token: issued.token.secret };
}

/**
 * A mission of the approver on a GitHub connection of their own, issued from the
 * plugin's `developer` preset exactly as shipped: its gated entries are what the
 * "approve an action" scenario is about. The connection is an installation of the
 * mocked GitHub, so an approved call goes all the way to the provider.
 */
async function issueDeveloperMission(
  root: GatewayRoot,
  name: string,
): Promise<{ mission_id: string; token: string }> {
  const user = await root.store.users.upsertFromIdp({
    issuer: IDP_ISSUER,
    subject: E2E_APPROVER_USER.sub,
    email: E2E_APPROVER_USER.email,
    displayName: E2E_APPROVER_USER.name,
  });
  const [repository] = MOCK_GITHUB.repositories;
  const seeded = await seedConnection(root.store, {
    provider: 'github',
    owner: { kind: 'user', id: user.id },
    displayName: 'hedy-org',
    resources: [{ ref: repository }],
  });
  await root.store.connections.reconnect(
    seeded.connection.id,
    serializeSecret({
      kind: 'app-install',
      installationId: MOCK_GITHUB.installationId,
      metadata: {},
    }),
  );
  const issued = await root.missions.service.issue(user, {
    name,
    connections: [{ connection_id: seeded.connection.id, preset: 'developer' }],
    period: { kind: 'recurring', length_seconds: 86_400 },
    expires_at: null,
  });
  if (!issued.ok) throw new Error(`mission "${name}" was not issued from the developer preset`);
  return { mission_id: issued.mission.id, token: issued.token.secret };
}

async function main(): Promise<void> {
  if (!existsSync(STANDALONE_SERVER)) {
    throw new Error(
      `${STANDALONE_SERVER} is missing — run "npm run build" first (npm run test:e2e:v5 does)`,
    );
  }
  const port = instancePort();
  const idp = new FakeIdp({ issuer: IDP_ISSUER, ...CLIENT });
  // No default user: the IdP has no claims to hand out until a spec says who
  // signs in (`idp/next-user`), so a spec that forgets to fails at its sign-in.
  const github = mockedGithub();

  // Build the root where production code looks for it (`globalThis`), before
  // Next boots: the app's own `getRoot()` then finds it already there.
  const root = await getRoot(
    testRootDeps({
      publicUrl: PUBLIC_URL,
      // The admin rule names the operator of the share spec.
      env: { ...githubEnv(), VAUBAAN_ADMIN_EMAILS: E2E_OPERATOR.email },
      deps: { oidc: { fetch: idp.fetch }, providerFetch: github },
    }),
  );
  await root.auth.idp.save({
    issuer: idp.issuer.href,
    clientId: CLIENT.clientId,
    clientSecret: CLIENT.clientSecret,
    claims: { sub: 'sub', email: 'email', groups: 'groups' },
    allowedEmailDomains: [],
  });
  // Seeded under the issuer their ID tokens will carry: the same people sign in below.
  const seeded = await seedInstance(root, idp.iss);
  // Ada's GitHub connection is an installation of the mocked GitHub, so her
  // missions' calls go all the way through the door to the mocked provider.
  await root.store.connections.reconnect(
    seeded.github.connection.id,
    serializeSecret({
      kind: 'app-install',
      installationId: MOCK_GITHUB.installationId,
      metadata: {},
    }),
  );

  // The control endpoints: the launcher's own listener, beside the app's port.
  const control = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', `http://${LOOPBACK}:${controlPort()}`);
      if (url.pathname === `${CONTROL_PREFIX}/idp/authorize`) {
        // The consent step of the simulated IdP: answer with the callback URL
        // the IdP would redirect the browser to.
        const authorization = new URL('/authorize', idp.issuer);
        authorization.search = url.search;
        sendJson(res, 200, { callback: idp.authorize(authorization).href });
        return;
      }
      if (url.pathname === `${CONTROL_PREFIX}/idp/next-user` && req.method === 'POST') {
        // Who the simulated IdP signs in at the next consent.
        const user = JSON.parse(await readBody(req)) as {
          sub: string;
          email: string;
          name: string;
        };
        idp.nextClaims = { ...user, groups: [] };
        sendJson(res, 200, { ok: true });
        return;
      }
      if (url.pathname === `${CONTROL_PREFIX}/provider-pages`) {
        // The provider pages a browser is sent to during a connect flow.
        sendJson(res, 200, { pages: [GITHUB_INSTALL_PAGE] });
        return;
      }
      if (url.pathname === `${CONTROL_PREFIX}/provider-page`) {
        // The user's step on such a page: where the provider sends them back.
        const callback = githubInstallCallback(new URL(url.searchParams.get('url') ?? ''));
        if (callback) sendJson(res, 200, { callback });
        else sendJson(res, 404, { error: 'not a page of a mocked provider' });
        return;
      }
      if (url.pathname === `${CONTROL_PREFIX}/upstream`) {
        // What the mocked provider received, and whether each request carried
        // the installation token the gateway minted. The token itself is
        // handed over so a spec can check it never reached the executor.
        sendJson(res, 200, {
          installation_token: INSTALLATION_TOKEN,
          calls: github.calls.map((call) => ({
            method: call.method,
            url: call.url,
            with_installation_token: (call.headers.authorization ?? '').endsWith(
              INSTALLATION_TOKEN,
            ),
          })),
        });
        return;
      }
      if (url.pathname === `${CONTROL_PREFIX}/small-mission` && req.method === 'POST') {
        const { name } = JSON.parse(await readBody(req)) as { name: string };
        sendJson(
          res,
          200,
          await issueSmallMission(root, seeded.ada, seeded.github.connection.id, name),
        );
        return;
      }
      if (url.pathname === `${CONTROL_PREFIX}/developer-mission` && req.method === 'POST') {
        const { name } = JSON.parse(await readBody(req)) as { name: string };
        sendJson(res, 200, await issueDeveloperMission(root, name));
        return;
      }
      if (url.pathname === `${CONTROL_PREFIX}/share-scenario` && req.method === 'POST') {
        // The cast of the share spec, known to the instance as after a first sign-in,
        // and a GitHub connection the owner holds in their own name.
        const { name } = JSON.parse(await readBody(req)) as { name: string };
        const [owner] = await Promise.all(
          [E2E_SHARE_OWNER, E2E_SHARE_TARGET, E2E_OPERATOR].map((user) =>
            root.store.users.upsertFromIdp({
              issuer: IDP_ISSUER,
              subject: user.sub,
              email: user.email,
              displayName: user.name,
            }),
          ),
        );
        if (!owner) throw new Error('the share owner was not created');
        const { connection } = await seedConnection(root.store, {
          provider: 'github',
          owner: { kind: 'user', id: owner.id },
          displayName: name,
          resources: MOCK_GITHUB.repositories.map((ref) => ({ ref })),
        });
        await root.store.connections.reconnect(
          connection.id,
          serializeSecret({
            kind: 'app-install',
            installationId: MOCK_GITHUB.installationId,
            metadata: {},
          }),
        );
        sendJson(res, 200, { connection_id: connection.id });
        return;
      }
      if (url.pathname === `${CONTROL_PREFIX}/verify-token` && req.method === 'POST') {
        const { token } = JSON.parse(await readBody(req)) as { token: string };
        const verification = await root.missions.service.verifyToken(token);
        sendJson(res, 200, {
          outcome: verification.outcome,
          reason: verification.outcome === 'retired' ? verification.reason : null,
          mission_status: verification.outcome === 'unknown' ? null : verification.mission.status,
        });
        return;
      }
      if (url.pathname === `${CONTROL_PREFIX}/seed-day` && req.method === 'POST') {
        // A user of their own, with their own GitHub connection: the open
        // requests this leaves behind are in nobody else's inbox.
        const user = await root.store.users.upsertFromIdp({
          issuer: IDP_ISSUER,
          subject: E2E_AUDIT_USER.sub,
          email: E2E_AUDIT_USER.email,
          displayName: E2E_AUDIT_USER.name,
        });
        const connection = await seedConnection(root.store, {
          provider: 'github',
          owner: { kind: 'user', id: user.id },
          displayName: 'grace-org',
          resources: [{ ref: 'grace/app' }],
        });
        // Recorded below the door, through the root's own budget: the day
        // holds gated and refused calls no mocked provider could answer.
        const rig: AuditRig = {
          root,
          seeded: { ...seeded, ada: user, github: connection },
          budget: root.budget,
        };
        sendJson(res, 200, await seedDayOfWork(rig));
        return;
      }
      sendJson(res, 404, { error: 'not a control endpoint' });
    })().catch((err: unknown) => {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    });
  });
  // Up before the app: Playwright waits for the app's `/healthz`, so a spec never
  // reaches a control endpoint that is not listening yet.
  control.keepAliveTimeout = IDLE_SOCKET_MS;
  await new Promise<void>((ready, failed) => {
    control.once('error', failed);
    control.listen(controlPort(), LOOPBACK, ready);
  });

  // What deploy/docker/Dockerfile copies beside server.js: Next leaves the static
  // assets and `public/` out of the standalone tree.
  cpSync(resolve(APP_DIR, '.next/static'), resolve(STANDALONE_APP, '.next/static'), {
    recursive: true,
  });
  cpSync(resolve(APP_DIR, 'public'), resolve(STANDALONE_APP, 'public'), { recursive: true });
  // The two variables server.js reads, as the image sets them (`ENV PORT`, `ENV
  // HOSTNAME`). A shell usually exports HOSTNAME as the machine's name: without the
  // second line the server would listen on that address.
  process.env.PORT = String(port);
  process.env.HOSTNAME = LOOPBACK;
  // The third variable server.js reads: how long it keeps an idle connection open.
  process.env.KEEP_ALIVE_TIMEOUT = String(IDLE_SOCKET_MS);
  // The image's own entry point, unmodified. It changes the working directory to its
  // own; every path of this file is absolute. The root is already where its
  // `getRoot()` looks.
  createRequire(import.meta.url)(STANDALONE_SERVER);
  process.stdout.write(
    `ephemeral instance: ${STANDALONE_SERVER} on http://${LOOPBACK}:${port} as ${PUBLIC_URL}, ` +
      `control endpoints on port ${controlPort()}\n`,
  );
  const stop = (): void => {
    control.close();
    void root.close().finally(() => process.exit(0));
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
