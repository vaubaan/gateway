/**
 * "Exhaust and claim" over the real composition root (spec §7.6, §3.4, §6):
 * the budget refuses with the claim URL, the URL lets nobody but the creator
 * in, the creator's decision makes the replay pass. Also the credential
 * separation on the request surface and its per-IP rate limit.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SESSION_COOKIE } from '../../../src/server/auth';
import {
  budgetMissionOf,
  SessionService,
  type BudgetMission,
  type RecordCallResult,
} from '../../../src/server/budget';
import type { GatewayRoot } from '../../../src/server/compose/root';
import { SlidingWindowRateLimiter } from '../../../src/server/rate-limit';
import {
  ADDRESSED_TO_CREATOR,
  REQUEST_PAGE_RATE_LIMIT,
  type RequestSummary,
} from '../../../src/server/requests';
import {
  buildTestRoot,
  PUBLIC_URL,
  seedInstance,
  sessionHeaders,
  type SeededInstance,
} from '../missions/support';

const RISK = 'github.read-code';
const OTHER_RISK = 'github.read-meta';

describe('requests: exhaust and claim over HTTP', () => {
  let root: GatewayRoot;
  let seeded: SeededInstance;
  let budget: SessionService;
  let mission: BudgetMission;
  let token: string;

  beforeEach(async () => {
    root = await buildTestRoot();
    seeded = await seedInstance(root);
    // What the execution door composes: the budget's service on the root's
    // store, with the request URL of the requests module.
    budget = new SessionService({
      sessions: root.store.sessions,
      requests: root.store.requests,
      rateWindows: new SlidingWindowRateLimiter(),
      requestUrl: root.requests.requestUrl,
      requestExpirySeconds: root.config.requests.expirySeconds,
      approvalValiditySeconds: root.config.approvals.expirySeconds,
    });
    const issued = await root.missions.service.issue(seeded.ada, {
      name: 'Read the billing code',
      connections: [
        {
          connection_id: seeded.github.connection.id,
          policy: [
            { risk_id: RISK, quota: 2, rate_limit: { max: 60, window_seconds: 60 }, gate: 'auto' },
            {
              risk_id: OTHER_RISK,
              quota: 5,
              rate_limit: { max: 60, window_seconds: 60 },
              gate: 'auto',
            },
          ],
        },
      ],
      period: { kind: 'recurring', length_seconds: 86_400 },
      expires_at: null,
    });
    if (!issued.ok) throw new Error('the mission should be issued');
    mission = budgetMissionOf(issued.mission);
    token = issued.token.secret;
  });
  afterEach(async () => {
    await root.close();
  });

  const call = (): Promise<RecordCallResult> =>
    budget.recordCall({
      mission,
      tool: 'github__get_file_contents',
      args: { repo: 'acme/app', path: 'README.md' },
      risks_touched: [RISK],
      agent_label: null,
      now: new Date(),
    });

  /** Two allowed calls, then the refusal: its claim URL. */
  async function exhaust(): Promise<{ id: string; url: string }> {
    expect((await call()).outcome).toBe('allowed');
    expect((await call()).outcome).toBe('allowed');
    const refused = await call();
    if (refused.outcome !== 'refused' || refused.refusal.code !== 'budget-exhausted') {
      throw new Error('expected budget-exhausted');
    }
    if (!refused.request_id) throw new Error('expected a claim');
    return { id: refused.request_id, url: refused.refusal.claim_url };
  }

  const get = (url: string, headers: Headers = new Headers()): Request =>
    new Request(url, { method: 'GET', headers });

  function decideRequest(id: string, headers: Headers, body: unknown): Request {
    return new Request(`${PUBLIC_URL}/api/requests/${id}/decide`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
  }

  it('exhaust → refusal URL → non-creator 403 → creator grants a reset → the replay passes', async () => {
    const claim = await exhaust();
    expect(claim.url).toBe(`${PUBLIC_URL}/r/${claim.id}`);

    // Nobody signed in: the sign-in, then back to the same URL.
    const anonymous = await root.requests.handlers.open(get(claim.url), claim.id);
    expect(anonymous.status).toBe(303);
    expect(anonymous.headers.get('location')).toBe(
      `/auth/login?return_to=${encodeURIComponent(`/r/${claim.id}`)}`,
    );

    // Someone else: 403, one sentence, no detail.
    const bob = await root.requests.handlers.open(
      get(claim.url, await sessionHeaders(root, seeded.bob)),
      claim.id,
    );
    expect(bob.status).toBe(403);
    expect(bob.headers.get('content-type')).toContain('text/html');
    const page = await bob.text();
    expect(page).toContain(ADDRESSED_TO_CREATOR);
    for (const detail of ['Read the billing code', RISK, mission.id, seeded.ada.email, 'acme']) {
      expect(page).not.toContain(detail);
    }

    // The creator: on to the request in the inbox.
    const ada = await root.requests.handlers.open(
      get(claim.url, await sessionHeaders(root, seeded.ada)),
      claim.id,
    );
    expect(ada.status).toBe(303);
    expect(ada.headers.get('location')).toBe(`/requests/${claim.id}`);

    const decided = await root.requests.handlers.decide(
      decideRequest(claim.id, await sessionHeaders(root, seeded.ada), {
        resolution: 'reset-period',
      }),
      claim.id,
    );
    expect(decided.status).toBe(200);
    expect(decided.headers.get('cache-control')).toBe('no-store');
    const body = (await decided.json()) as { request: RequestSummary };
    expect(body.request).toMatchObject({ id: claim.id, state: 'granted', url: claim.url });

    // Same token, same call.
    expect((await call()).outcome).toBe('allowed');
  });

  it('an unknown id and someone else’s request are the same 403', async () => {
    const claim = await exhaust();
    const headers = await sessionHeaders(root, seeded.bob);
    const theirs = await root.requests.handlers.open(get(claim.url, headers), claim.id);
    const unknown = await root.requests.handlers.open(get(`${PUBLIC_URL}/r/nope`, headers), 'nope');
    expect(unknown.status).toBe(403);
    expect(await unknown.text()).toBe(await theirs.text());
  });

  it('a co-owner of the connection is not the creator', async () => {
    const claim = await exhaust();
    const group = await root.store.groups.getOrCreate('platform', 'idp');
    await root.store.groups.addMember(group.id, seeded.ada.id);
    await root.store.groups.addMember(group.id, seeded.bob.id);
    await root.store.connections.transferOwner(seeded.github.connection.id, {
      kind: 'group',
      id: group.id,
    });
    const headers = await sessionHeaders(root, seeded.bob);
    expect((await root.requests.handlers.open(get(claim.url, headers), claim.id)).status).toBe(403);
    const decided = await root.requests.handlers.decide(
      decideRequest(claim.id, headers, { resolution: 'reset-period' }),
      claim.id,
    );
    expect(decided.status).toBe(403);
    expect(await decided.json()).toEqual({ error: 'forbidden', message: ADDRESSED_TO_CREATOR });
    expect((await call()).outcome).toBe('refused');
  });

  it('the bootstrap operator is nobody’s creator', async () => {
    const claim = await exhaust();
    const session = await root.auth.sessions.create({ kind: 'bootstrap' });
    const headers = new Headers({
      cookie: `${SESSION_COOKIE}=${session.id}`,
      origin: PUBLIC_URL,
      'content-type': 'application/json',
    });
    expect((await root.requests.handlers.open(get(claim.url, headers), claim.id)).status).toBe(403);
    expect(
      (
        await root.requests.handlers.decide(
          decideRequest(claim.id, headers, { resolution: 'reset-period' }),
          claim.id,
        )
      ).status,
    ).toBe(403);
  });

  describe('credential separation (spec §6)', () => {
    it('the mission token cannot open the request page nor decide, even next to the creator’s session', async () => {
      const claim = await exhaust();
      for (const authorization of [`Bearer ${token}`, `bearer ${token}`]) {
        const opened = await root.requests.handlers.open(
          get(claim.url, new Headers({ authorization })),
          claim.id,
        );
        expect(opened.status).toBe(403);
        expect(await opened.json()).toMatchObject({
          error: 'wrong-credential-kind',
          presented: 'mission-token',
          expected: 'human-session',
        });
      }

      const withSession = await sessionHeaders(root, seeded.ada, {
        authorization: `Bearer ${token}`,
      });
      const decided = await root.requests.handlers.decide(
        decideRequest(claim.id, withSession, { resolution: 'reset-period' }),
        claim.id,
      );
      expect(decided.status).toBe(403);
      expect(await decided.json()).toMatchObject({ error: 'wrong-credential-kind' });
      // The executor did not claim for itself.
      expect((await root.store.requests.getById(claim.id))?.state).toBe('open');
      expect((await call()).outcome).toBe('refused');
    });

    it('any other bearer (a delegated token) is refused the same way', async () => {
      const claim = await exhaust();
      const headers = new Headers({ authorization: 'Bearer some-delegated-access-token' });
      const opened = await root.requests.handlers.open(get(claim.url, headers), claim.id);
      expect(opened.status).toBe(403);
      expect(await opened.json()).toMatchObject({
        error: 'wrong-credential-kind',
        presented: 'bearer',
      });
      const inbox = await root.requests.handlers.inbox(get(`${PUBLIC_URL}/api/requests`, headers));
      expect(inbox.status).toBe(403);
    });
  });

  describe('POST /api/requests/:id/decide', () => {
    it('needs the origin check, then a session', async () => {
      const claim = await exhaust();
      const crossOrigin = await sessionHeaders(root, seeded.ada, { origin: 'https://evil.test' });
      const refused = await root.requests.handlers.decide(
        decideRequest(claim.id, crossOrigin, { resolution: 'reset-period' }),
        claim.id,
      );
      expect(refused.status).toBe(403);
      expect(await refused.json()).toMatchObject({ error: 'origin-mismatch' });

      const noSession = await root.requests.handlers.decide(
        decideRequest(
          claim.id,
          new Headers({ origin: PUBLIC_URL, 'content-type': 'application/json' }),
          { resolution: 'reset-period' },
        ),
        claim.id,
      );
      expect(noSession.status).toBe(401);
      expect((await root.store.requests.getById(claim.id))?.state).toBe('open');
    });

    it('answers 422 for a decision the situation refuses, 409 once decided, 400 for a non-body', async () => {
      const claim = await exhaust();
      const headers = await sessionHeaders(root, seeded.ada);
      const tooMuch = await root.requests.handlers.decide(
        decideRequest(claim.id, headers, { resolution: 'extend-quota', amount: 3 }),
        claim.id,
      );
      expect(tooMuch.status).toBe(422);
      expect(await tooMuch.json()).toMatchObject({ error: 'invalid-amount' });

      const notJson = await root.requests.handlers.decide(
        new Request(`${PUBLIC_URL}/api/requests/${claim.id}/decide`, {
          method: 'POST',
          headers,
          body: '{',
        }),
        claim.id,
      );
      expect(notJson.status).toBe(400);

      const ok = await root.requests.handlers.decide(
        decideRequest(claim.id, headers, { resolution: 'extend-quota', amount: 2 }),
        claim.id,
      );
      expect(ok.status).toBe(200);

      const again = await root.requests.handlers.decide(
        decideRequest(claim.id, headers, { resolution: 'refuse' }),
        claim.id,
      );
      expect(again.status).toBe(409);
      expect(await again.json()).toMatchObject({ error: 'request-not-open', state: 'granted' });
    });

    it('the page’s form posts and is redirected back to the request', async () => {
      const claim = await exhaust();
      const form = async (fields: Record<string, string>): Promise<Response> => {
        const headers = await sessionHeaders(root, seeded.ada, {
          'content-type': 'application/x-www-form-urlencoded',
        });
        return root.requests.handlers.decide(
          new Request(`${PUBLIC_URL}/api/requests/${claim.id}/decide`, {
            method: 'POST',
            headers,
            body: new URLSearchParams(fields).toString(),
          }),
          claim.id,
        );
      };

      const invalid = await form({ resolution: 'extend-quota', amount: '9' });
      expect(invalid.status).toBe(303);
      expect(invalid.headers.get('location')).toBe(`/requests/${claim.id}?problem=invalid-amount`);

      const granted = await form({ resolution: 'extend-quota', amount: '1' });
      expect(granted.status).toBe(303);
      expect(granted.headers.get('location')).toBe(`/requests/${claim.id}?decided=1`);
      expect((await call()).outcome).toBe('allowed');
      expect((await call()).outcome).toBe('refused');

      const late = await form({ resolution: 'refuse' });
      expect(late.headers.get('location')).toBe(`/requests/${claim.id}?problem=request-not-open`);
    });
  });

  describe('GET /api/requests', () => {
    it('lists my open requests as creator; nothing for anyone else; 401 without a session', async () => {
      const claim = await exhaust();
      const mine = await root.requests.handlers.inbox(
        get(`${PUBLIC_URL}/api/requests`, await sessionHeaders(root, seeded.ada)),
      );
      expect(mine.status).toBe(200);
      expect(await mine.json()).toMatchObject({
        requests: [{ id: claim.id, kind: 'claim', state: 'open', risk_id: RISK, url: claim.url }],
      });

      const theirs = await root.requests.handlers.inbox(
        get(`${PUBLIC_URL}/api/requests`, await sessionHeaders(root, seeded.bob)),
      );
      expect(await theirs.json()).toEqual({ requests: [] });

      expect((await root.requests.handlers.inbox(get(`${PUBLIC_URL}/api/requests`))).status).toBe(
        401,
      );
    });

    it('labels the risk from the plugin catalog', async () => {
      await exhaust();
      const [request] = await root.requests.service.inbox(seeded.ada);
      const catalog = root.registry.get('github')?.plugin.catalog;
      const label = catalog?.risks.find((risk) => risk.id === RISK)?.label;
      expect(label).toBeTruthy();
      expect(request?.risk_label).toBe(label);
    });
  });

  describe('per-IP rate limit on /r/*', () => {
    it('answers 429 with Retry-After once the window is spent, before looking at anything', async () => {
      const claim = await exhaust();
      const headers = await sessionHeaders(root, seeded.ada);
      for (let i = 0; i < REQUEST_PAGE_RATE_LIMIT; i += 1) {
        const res = await root.requests.handlers.open(get(claim.url, headers), claim.id);
        expect(res.status).toBe(303);
      }
      const limited = await root.requests.handlers.open(get(claim.url, headers), claim.id);
      expect(limited.status).toBe(429);
      expect(Number(limited.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
      expect(await limited.text()).not.toContain('Read the billing code');
      // The decision endpoint is not behind the page's limit: the creator can still answer.
      const decided = await root.requests.handlers.decide(
        decideRequest(claim.id, headers, { resolution: 'refuse' }),
        claim.id,
      );
      expect(decided.status).toBe(200);
    });
  });

  describe('composition', () => {
    it('the root runs the sweeper and stops it on close', async () => {
      const claim = await exhaust();
      expect(await root.requests.sweeper.runOnce()).toBe(0);
      expect((await root.store.requests.getById(claim.id))?.state).toBe('open');
      expect(root.requests.requestUrl('abc')).toBe(`${PUBLIC_URL}/r/abc`);
    });
  });
});
