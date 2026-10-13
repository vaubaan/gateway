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
 *   - control endpoints under `/__e2e`, which exist only in this file: the
 *     IdP's consent screen (the browser cannot reach the in-process IdP) and
 *     who signs in next, a token check through `MissionService.verifyToken`,
 *     and the executor's side of "exhaust and claim" — calls recorded
 *     straight through the budget's `SessionService.recordCall`, as the
 *     execution door does — and `seed-day`, a day of calls with their audit
 *     entries on a new mission, for the audit pages.
 *
 * Run by Playwright's `webServer` (see `playwright.config.ts` next to this
 * file) after `next build`. Never part of the image.
 */
import { existsSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import nextModule from 'next';

import { budgetMissionOf, SessionService } from '../../../src/server/budget';
import { getRoot, type GatewayRoot } from '../../../src/server/compose/root';
import { SlidingWindowRateLimiter } from '../../../src/server/rate-limit';
import type { UserRecord } from '../../../src/server/store/types';
import { auditRigOn, seedDayOfWork } from '../../integration/audit/support';
import { FakeIdp } from '../../integration/auth/fake-idp';
import { seedInstance, testRootDeps } from '../../integration/missions/support';
import { seedConnection } from '../../../src/server/missions/testing';
import {
  CONTROL_PREFIX,
  E2E_AUDIT_USER,
  E2E_USER,
  IDP_ISSUER,
  instancePort,
  PUBLIC_URL,
} from './instance';

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

/** The risk the executor of "exhaust and claim" spends, and its quota. */
const EXHAUST_RISK = 'github.read-code';
const EXHAUST_QUOTA = 2;

/**
 * The executor's side of spec §7.6, without the execution door: a mission of
 * `creator` with a two-action quota, called until the budget refuses.
 */
function executor(root: GatewayRoot, creator: UserRecord, githubConnectionId: string) {
  const budget = new SessionService({
    sessions: root.store.sessions,
    requests: root.store.requests,
    rateWindows: new SlidingWindowRateLimiter(),
    requestUrl: root.requests.requestUrl,
    requestExpirySeconds: root.config.requests.expirySeconds,
  });

  async function call(missionId: string) {
    const mission = await root.store.missions.getById(missionId);
    if (!mission) throw new Error(`no mission ${missionId}`);
    return budget.recordCall({
      mission: budgetMissionOf(mission),
      tool: 'github__get_file_contents',
      args: { repo: 'acme/app', path: 'README.md' },
      risks_touched: [EXHAUST_RISK],
      agent_label: 'e2e-agent',
      now: new Date(),
    });
  }

  return {
    async exhaust(name: string) {
      const issued = await root.missions.service.issue(creator, {
        name,
        connections: [
          {
            connection_id: githubConnectionId,
            policy: [
              {
                risk_id: EXHAUST_RISK,
                quota: EXHAUST_QUOTA,
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
      for (let i = 0; i <= EXHAUST_QUOTA; i += 1) {
        const result = await call(issued.mission.id);
        if (result.outcome === 'refused') {
          return { mission_id: issued.mission.id, refusal: result.refusal };
        }
      }
      throw new Error('the budget never refused');
    },
    async replay(missionId: string) {
      const result = await call(missionId);
      return result.outcome === 'allowed'
        ? { outcome: result.outcome, refusal: null }
        : { outcome: result.outcome, refusal: result.refusal };
    },
  };
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
  const seeded = await seedInstance(root);
  const agent = executor(root, seeded.ada, seeded.github.connection.id);

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
      if (url.pathname === `${CONTROL_PREFIX}/exhaust` && req.method === 'POST') {
        const { name } = JSON.parse(await readBody(req)) as { name: string };
        sendJson(res, 200, await agent.exhaust(name));
        return;
      }
      if (url.pathname === `${CONTROL_PREFIX}/replay` && req.method === 'POST') {
        const { mission_id: missionId } = JSON.parse(await readBody(req)) as { mission_id: string };
        sendJson(res, 200, await agent.replay(missionId));
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
          subject: E2E_AUDIT_USER.sub,
          email: E2E_AUDIT_USER.email,
          displayName: E2E_AUDIT_USER.name,
        });
        const github = await seedConnection(root.store, {
          provider: 'github',
          owner: { kind: 'user', id: user.id },
          displayName: 'grace-org',
          resources: [{ ref: 'grace/app' }],
        });
        const rig = auditRigOn(root, { ...seeded, ada: user, github });
        sendJson(res, 200, await seedDayOfWork(rig));
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
