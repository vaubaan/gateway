/**
 * Separation of the three credentials (spec §6; §10 "a mission token on the
 * management surface, a delegated token on the execution surface, either on a
 * request, are refused unambiguously").
 *
 * One instance, the three real credentials — a mission token issued by the
 * mission service, a delegated token obtained through the OAuth flow, a web
 * session from the IdP sign-in — each presented at every surface that is not
 * its own, over the real doors and handlers.
 */
import { hashApiKeyArgon2id } from '@vaubaan/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SESSION_COOKIE } from '../../../src/server/auth';
import { githubDraft, auditRigOn, PR, seedCall } from '../audit/support';
import { seedInstance, type SeededInstance } from '../missions/support';
import {
  ADA,
  bearer,
  BOB,
  delegate,
  EXECUTION_URL,
  MANAGEMENT_URL,
  openInstance,
  PUBLIC_URL,
  toolsList,
  type Browser,
  type Delegated,
  type Instance,
} from './support';

interface RpcBody {
  readonly result?: { readonly tools?: unknown[] };
  readonly error?: {
    readonly code: number;
    readonly message: string;
    readonly data?: Record<string, unknown>;
  };
}

describe('the three credentials never cross over', () => {
  let instance: Instance;
  let seeded: SeededInstance;
  let browser: Browser;
  let delegated: Delegated;
  /** The secret of a mission token of Ada. */
  let missionToken: string;
  let missionId: string;
  /** The id of Ada's web session (the value of her cookie). */
  let sessionId: string;

  beforeEach(async () => {
    instance = await openInstance();
    seeded = await seedInstance(instance.root);
    browser = instance.browser();
    delegated = await delegate(instance, ADA, browser);
    expect(delegated.user.id).toBe(seeded.ada.id);

    const rig = auditRigOn(instance.root, seeded);
    const issued = await instance.root.missions.service.issue(seeded.ada, githubDraft(rig));
    if (!issued.ok) throw new Error('the mission was not issued');
    missionToken = issued.token.secret;
    missionId = issued.mission.id;
    sessionId = browser.cookies.get(SESSION_COOKIE) ?? '';
    expect(sessionId).not.toBe('');
  });
  afterEach(() => instance.close());

  async function rpc(url: string, headers: Record<string, string>) {
    const response = await toolsList(instance, url, headers);
    return { response, body: (await response.json()) as RpcBody };
  }

  describe('each credential opens its own door', () => {
    it('the mission token opens the execution door', async () => {
      const { response, body } = await rpc(EXECUTION_URL, bearer(missionToken));
      expect(response.status).toBe(200);
      expect(body.result?.tools?.length).toBeGreaterThan(0);
    });

    it('the delegated token opens the management door', async () => {
      const { response, body } = await rpc(MANAGEMENT_URL, bearer(delegated.tokens.access_token));
      expect(response.status).toBe(200);
      expect(body.result?.tools).toHaveLength(7);
    });
  });

  describe('the execution door', () => {
    it('refuses a delegated token with wrong-credential-kind, naming the door that accepts it', async () => {
      const { response, body } = await rpc(EXECUTION_URL, bearer(delegated.tokens.access_token));
      expect(response.status).toBe(403);
      expect(body.error?.data).toMatchObject({
        code: 'wrong-credential-kind',
        door: 'execution',
        presented: 'delegated-token',
        expected: 'mission-token',
      });
      expect(String(body.error?.data?.hint)).toContain('management door');
      // No OAuth challenge: another token of the same kind would not help.
      expect(response.headers.get('www-authenticate')).toBeNull();
    });

    it('does not recognise a delegated token that is revoked, nor a refresh token: unknown bearer', async () => {
      const refresh = await rpc(EXECUTION_URL, bearer(delegated.tokens.refresh_token));
      expect(refresh.response.status).toBe(401);
      await instance.root.oauth.delegations.revoke(delegated.user, delegated.delegationId);
      const revoked = await rpc(EXECUTION_URL, bearer(delegated.tokens.access_token));
      expect(revoked.response.status).toBe(401);
    });

    it('leaves no trace of a refused delegated token in the mission’s session or audit', async () => {
      const before = instance.root.store.db.prepare('SELECT COUNT(*) AS n FROM audit').get();
      await rpc(EXECUTION_URL, bearer(delegated.tokens.access_token));
      expect(instance.root.store.db.prepare('SELECT COUNT(*) AS n FROM audit').get()).toEqual(
        before,
      );
      expect(instance.root.store.db.prepare('SELECT * FROM sessions').all()).toEqual([]);
    });
  });

  describe('the management door', () => {
    it('refuses a mission token with wrong-credential-kind, naming the door that accepts it', async () => {
      const { response, body } = await rpc(MANAGEMENT_URL, bearer(missionToken));
      expect(response.status).toBe(403);
      expect(body.error?.data).toMatchObject({
        code: 'wrong-credential-kind',
        door: 'management',
        presented: 'mission-token',
        expected: 'delegated-token',
      });
      expect(String(body.error?.data?.hint)).toContain('execution door');
      // No OAuth challenge: an MCP client must not start a flow for it.
      expect(response.headers.get('www-authenticate')).toBeNull();
    });

    it('refuses every kind of mission token alike: a member’s own and a named one open the execution door only', async () => {
      const { team } = instance.root.missions;
      const added = await team.addMember(seeded.ada, missionId, { email: seeded.bob.email });
      const member = await team.generateToken(seeded.bob, missionId);
      const named = await team.createNamedToken(seeded.ada, missionId, 'CI runner');
      if (!added.ok || !member.ok || !named.ok) throw new Error('the team was not set up');
      for (const token of [member.token.secret, named.token.secret]) {
        expect((await rpc(EXECUTION_URL, bearer(token))).response.status).toBe(200);
        const { response, body } = await rpc(MANAGEMENT_URL, bearer(token));
        expect(response.status).toBe(403);
        expect(body.error?.data).toMatchObject({
          code: 'wrong-credential-kind',
          presented: 'mission-token',
          expected: 'delegated-token',
        });
      }
      // Being a member gives no way to manage the mission through the other door either:
      // Bob's delegated agent reads it, and changes nothing of it.
      const bobs = await delegate(instance, BOB, instance.browser());
      const asBob = await instance.root.management.tools.listMyMissions(
        { userId: bobs.user.id, delegationId: bobs.delegationId, clientId: bobs.clientId },
        {},
      );
      expect(asBob.ok && asBob.data.missions.map((m) => [m.mission_id, m.role])).toEqual([
        [missionId, 'member'],
      ]);
    });

    it('refuses a web session — as a cookie or as a bearer — with wrong-credential-kind', async () => {
      const expected = {
        code: 'wrong-credential-kind',
        door: 'management',
        presented: 'human-session',
        expected: 'delegated-token',
      };
      const asCookie = await rpc(MANAGEMENT_URL, { cookie: `${SESSION_COOKIE}=${sessionId}` });
      expect(asCookie.response.status).toBe(403);
      expect(asCookie.body.error?.data).toMatchObject(expected);
      const asBearer = await rpc(MANAGEMENT_URL, bearer(sessionId));
      expect(asBearer.response.status).toBe(403);
      expect(asBearer.body.error?.data).toMatchObject(expected);
    });

    it('a delegated token wins over a cookie sent next to it: the door reads the bearer only', async () => {
      const { response } = await rpc(MANAGEMENT_URL, {
        ...bearer(delegated.tokens.access_token),
        cookie: `${SESSION_COOKIE}=${sessionId}`,
      });
      expect(response.status).toBe(200);
    });

    it('answers 401 with the OAuth challenge to no credential, an unknown one, or a look-alike', async () => {
      const lookAlikes = [
        null,
        'garbage',
        `vbn_dat_${'a'.repeat(43)}`,
        // The shape of a mission token, but none of this instance: not identified, not a kind.
        `vbn_live_ZZZZZZZZ_${'y'.repeat(32)}`,
        delegated.tokens.refresh_token,
      ];
      for (const candidate of lookAlikes) {
        const { response } = await rpc(MANAGEMENT_URL, candidate ? bearer(candidate) : {});
        expect(response.status).toBe(401);
        const challenge = response.headers.get('www-authenticate') ?? '';
        expect(challenge).toMatch(/^Bearer /);
        expect(challenge).toContain(
          `resource_metadata="${PUBLIC_URL}/.well-known/oauth-protected-resource/mcp/manage"`,
        );
        expect(challenge).toContain('scope="mgmt"');
        // RFC 6750 §3.1: no error code when no credential was presented.
        expect(challenge.includes('error="invalid_token"')).toBe(candidate !== null);
      }
    });

    it('refuses the delegated token the moment its delegation is revoked', async () => {
      await instance.root.oauth.delegations.revoke(delegated.user, delegated.delegationId);
      const { response } = await rpc(MANAGEMENT_URL, bearer(delegated.tokens.access_token));
      expect(response.status).toBe(401);
    });

    it('refuses a browser origin other than the instance, whatever the token', async () => {
      const { response } = await rpc(MANAGEMENT_URL, {
        ...bearer(delegated.tokens.access_token),
        origin: 'https://evil.example',
      });
      expect(response.status).toBe(403);
    });

    const PREFIX = (): string => missionToken.slice('vbn_live_'.length, 'vbn_live_'.length + 8);

    it('answers 401 to a wrong secret on a real mission-token prefix, however often: nothing slow is computed', async () => {
      const wrong = `vbn_live_${PREFIX()}_${'x'.repeat(32)}`;
      const statuses = new Set<number>();
      for (let i = 0; i < 40; i += 1) {
        statuses.add((await rpc(MANAGEMENT_URL, bearer(wrong))).response.status);
      }
      expect([...statuses]).toEqual([401]);
    });

    it('throttles the identification of a mission token an earlier build stored as argon2id, like the execution door does', async () => {
      instance.root.store.db
        .prepare("UPDATE mission_tokens SET hash = ?, hash_alg = 'argon2id' WHERE prefix = ?")
        .run(await hashApiKeyArgon2id(missionToken), PREFIX());
      const wrong = `vbn_live_${PREFIX()}_${'x'.repeat(32)}`;
      const statuses = new Set<number>();
      for (let i = 0; i < 40; i += 1) {
        statuses.add((await rpc(MANAGEMENT_URL, bearer(wrong))).response.status);
      }
      expect([...statuses].sort()).toEqual([401, 429]);
    });
  });

  describe('the human interface', () => {
    const mutation = (path: string, headers: Record<string, string>, body: unknown): Request =>
      new Request(`${PUBLIC_URL}${path}`, {
        method: 'POST',
        headers: { origin: PUBLIC_URL, 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });

    it('is not opened by a delegated token: as a bearer it is nobody', async () => {
      const { root } = instance;
      const headers = bearer(delegated.tokens.access_token);
      expect(await root.auth.authenticator.authenticate(new Headers(headers))).toBeNull();

      const draft = githubDraft(auditRigOn(root, seeded));
      const issue = await root.missions.handlers.issue(mutation('/api/missions', headers, draft));
      expect(issue.status).toBe(401);
      const revoke = await root.missions.handlers.revoke(
        mutation(`/api/missions/${missionId}/revoke`, headers, {}),
        missionId,
      );
      expect(revoke.status).toBe(401);
      const ownDelegation = await root.oauth.handlers.revokeDelegation(
        mutation(`/delegations/${delegated.delegationId}/revoke`, headers, {}),
        delegated.delegationId,
      );
      expect(ownDelegation.status).toBe(401);
      expect((await root.store.missions.getById(missionId))?.status).toBe('active');
    });

    it('is not opened by a delegated token placed in the session cookie', async () => {
      const { root } = instance;
      for (const token of [delegated.tokens.access_token, delegated.tokens.refresh_token]) {
        const headers = { cookie: `${SESSION_COOKIE}=${token}` };
        expect(await root.auth.authenticator.authenticate(new Headers(headers))).toBeNull();
        const response = await root.missions.handlers.revoke(
          mutation(`/api/missions/${missionId}/revoke`, headers, {}),
          missionId,
        );
        expect(response.status).toBe(401);
      }
    });

    it('cannot consent to a delegation for itself: the consent answer needs the human session', async () => {
      const { root } = instance;
      const client = await root.store.delegations.getClientByClientId(delegated.clientId);
      const consentId = await root.oauth.authorization.createPending(seeded.ada, {
        client: client!,
        redirectUri: 'http://127.0.0.1:43210/callback',
        state: null,
        codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
      });
      const before = (await root.store.delegations.listForUser(seeded.ada.id)).length;
      for (const headers of [
        bearer(delegated.tokens.access_token),
        { cookie: `${SESSION_COOKIE}=${delegated.tokens.access_token}` },
        bearer(missionToken),
      ]) {
        const response = await root.oauth.handlers.decide(
          new Request(`${PUBLIC_URL}/oauth/authorize/decision`, {
            method: 'POST',
            headers: {
              origin: PUBLIC_URL,
              'content-type': 'application/x-www-form-urlencoded',
              ...headers,
            },
            body: new URLSearchParams({ consent: consentId, decision: 'approve' }).toString(),
          }),
        );
        expect(response.status).toBe(401);
      }
      expect(await root.store.delegations.listForUser(seeded.ada.id)).toHaveLength(before);
    });
  });

  describe('requests are granted only in a human session', () => {
    async function openClaim(): Promise<string> {
      const rig = auditRigOn(instance.root, seeded);
      const mission = await instance.root.store.missions.getById(missionId);
      if (!mission) throw new Error('mission not found');
      const pr = { tool: 'github__create_pull_request', risks: [PR] } as const;
      await seedCall(rig, mission, pr);
      await seedCall(rig, mission, pr);
      const refused = await seedCall(rig, mission, pr);
      if (refused.result.outcome !== 'refused' || !refused.result.request_id) {
        throw new Error('expected the third pull request to open a claim');
      }
      return refused.result.request_id;
    }

    it('a delegated token cannot answer a request, even next to the creator’s session', async () => {
      const claimId = await openClaim();
      const decide = (headers: Record<string, string>) =>
        instance.root.requests.handlers.decide(
          new Request(`${PUBLIC_URL}/api/requests/${claimId}/decide`, {
            method: 'POST',
            headers: { origin: PUBLIC_URL, 'content-type': 'application/json', ...headers },
            body: JSON.stringify({ resolution: 'reset-period' }),
          }),
          claimId,
        );

      const alone = await decide(bearer(delegated.tokens.access_token));
      expect(alone.status).toBe(403);
      expect(await alone.json()).toMatchObject({
        error: 'wrong-credential-kind',
        expected: 'human-session',
      });
      const withSession = await decide({
        ...bearer(delegated.tokens.access_token),
        cookie: `${SESSION_COOKIE}=${sessionId}`,
      });
      expect(withSession.status).toBe(403);
      const asCookie = await decide({
        cookie: `${SESSION_COOKIE}=${delegated.tokens.access_token}`,
      });
      expect(asCookie.status).toBe(401);
      expect((await instance.root.store.requests.getById(claimId))?.state).toBe('open');

      // The creator's session alone is what answers it.
      const creator = await decide({ cookie: `${SESSION_COOKIE}=${sessionId}` });
      expect(creator.status).toBe(200);
    });

    it('a delegated token cannot open the request page nor read the inbox', async () => {
      const claimId = await openClaim();
      const headers = bearer(delegated.tokens.access_token);
      const page = await instance.root.requests.handlers.open(
        new Request(`${PUBLIC_URL}/r/${claimId}`, { headers }),
        claimId,
      );
      expect(page.status).toBe(403);
      const inbox = await instance.root.requests.handlers.inbox(
        new Request(`${PUBLIC_URL}/api/requests`, { headers }),
      );
      expect(inbox.status).toBe(403);
    });
  });
});
