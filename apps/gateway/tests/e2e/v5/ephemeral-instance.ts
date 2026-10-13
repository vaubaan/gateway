/**
 * Launcher of an ephemeral gateway instance for the browser tests (spec §10
 * "integration on an ephemeral instance with embedded store and simulated
 * IdP"). One process:
 *
 *   - the real composition root, built here with the `:memory:` store, a
 *     registry of real plugins and P1.1's in-process `FakeIdp` as the relying
 *     party's `fetch`, and published on `globalThis` exactly as production
 *     does — so the Next server started below serves the built app on this
 *     root (`getRoot()` returns the promise already there);
 *   - connections and resources seeded straight through the repositories;
 *   - two control endpoints under `/__e2e`, which exist only in this file:
 *     the IdP's consent screen (the browser cannot reach the in-process
 *     IdP), and a token check through `MissionService.verifyToken`.
 *
 * Run by Playwright's `webServer` (see `playwright.config.ts` next to this
 * file) after `next build`. Never part of the image.
 */
import { existsSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import nextModule from 'next';

import { getRoot } from '../../../src/server/compose/root';
import { FakeIdp } from '../../integration/auth/fake-idp';
import { seedInstance, testRootDeps } from '../../integration/missions/support';
import { CONTROL_PREFIX, E2E_USER, IDP_ISSUER, instancePort, PUBLIC_URL } from './instance';

const CLIENT = { clientId: 'vaubaan-gateway-e2e', clientSecret: 'e2e-client-secret' };
const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

type NextFactory = (options: { dev: boolean; dir: string }) => {
  prepare(): Promise<void>;
  getRequestHandler(): (req: IncomingMessage, res: ServerResponse) => Promise<void>;
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<void> {
  if (!existsSync(resolve(APP_DIR, '.next/BUILD_ID'))) {
    throw new Error(
      `no production build under ${APP_DIR}/.next — run "npm run build" first (npm run test:e2e:v5 does)`,
    );
  }
  const port = instancePort();
  const idp = new FakeIdp({ issuer: IDP_ISSUER, ...CLIENT });
  idp.nextClaims = { ...E2E_USER, groups: [] };

  // Build the root where production code looks for it (`globalThis`), before
  // Next boots: the app's own `getRoot()` then finds it already there.
  const root = await getRoot(
    testRootDeps({ publicUrl: PUBLIC_URL, deps: { oidc: { fetch: idp.fetch } } }),
  );
  await root.auth.idp.save({
    issuer: idp.issuer.href,
    clientId: CLIENT.clientId,
    clientSecret: CLIENT.clientSecret,
    claims: { sub: 'sub', email: 'email', groups: 'groups' },
    allowedEmailDomains: [],
  });
  await seedInstance(root);

  const next = (
    typeof nextModule === 'function' ? nextModule : (nextModule as { default: unknown }).default
  ) as NextFactory;
  const app = next({ dev: false, dir: APP_DIR });
  await app.prepare();
  const handle = app.getRequestHandler();

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
      if (url.pathname === `${CONTROL_PREFIX}/idp/authorize`) {
        // The consent step of the simulated IdP: answer with the callback URL
        // the IdP would redirect the browser to.
        const authorization = new URL('/authorize', idp.issuer);
        authorization.search = url.search;
        sendJson(res, 200, { callback: idp.authorize(authorization).href });
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
      await handle(req, res);
    })().catch((err: unknown) => {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    });
  });
  server.listen(port, '127.0.0.1', () => {
    process.stdout.write(`ephemeral instance ready on http://127.0.0.1:${port} as ${PUBLIC_URL}\n`);
  });
  const stop = (): void => {
    server.close();
    void root.close().finally(() => process.exit(0));
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
