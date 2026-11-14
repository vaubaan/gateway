/**
 * Separation of the two credentials (spec §6; §10 "a session at the execution
 * surface, a mission token on a request, refused unambiguously"; ADR
 * platform-management-is-a-plugin-on-the-execution-door).
 *
 * One instance, the two real credentials — a mission token issued by the
 * mission service, a web session from the IdP sign-in — each presented where it
 * is not its own, over the real doors and handlers; and the retired management
 * door, which opens to neither.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SESSION_COOKIE } from '../../../src/server/auth';
import { auditRigOn, githubDraft } from '../audit/support';
import { seedInstance, type SeededInstance } from '../missions/support';
import {
  ADA,
  bearer,
  EXECUTION_URL,
  MANAGEMENT_URL,
  openInstance,
  PUBLIC_URL,
  toolsList,
  type Browser,
  type Instance,
} from '../vaubaan/support';

interface RpcBody {
  readonly result?: { readonly tools?: unknown[] };
  readonly error?: {
    readonly code: number;
    readonly message: string;
    readonly data?: Record<string, unknown>;
  };
}

describe('the two credentials never cross over', () => {
  let instance: Instance;
  let seeded: SeededInstance;
  let browser: Browser;
  /** The secret of a mission token of Ada. */
  let missionToken: string;
  let missionId: string;
  /** The id of Ada's web session (the value of her cookie). */
  let sessionId: string;

  beforeEach(async () => {
    instance = await openInstance();
    seeded = await seedInstance(instance.root);
    browser = instance.browser();
    const user = await browser.signIn(ADA);
    expect(user.id).toBe(seeded.ada.id);
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

  it('the mission token opens the execution door', async () => {
    const { response, body } = await rpc(EXECUTION_URL, bearer(missionToken));
    expect(response.status).toBe(200);
    expect(body.result?.tools?.length).toBeGreaterThan(0);
  });

  it('refuses a web session at the execution door — as a cookie or as a bearer — with wrong-credential-kind', async () => {
    const expected = {
      code: 'wrong-credential-kind',
      door: 'execution',
      presented: 'human-session',
      expected: 'mission-token',
    };
    const asCookie = await rpc(EXECUTION_URL, { cookie: `${SESSION_COOKIE}=${sessionId}` });
    expect(asCookie.response.status).toBe(403);
    expect(asCookie.body.error?.data).toMatchObject(expected);
    const asBearer = await rpc(EXECUTION_URL, bearer(sessionId));
    expect(asBearer.response.status).toBe(403);
    expect(asBearer.body.error?.data).toMatchObject(expected);
    // Nothing of the refused session reached a mission's session or audit.
    expect(instance.root.store.db.prepare('SELECT * FROM sessions').all()).toEqual([]);
  });

  it('refuses every kind of mission token alike on the request surface: requests are granted in a human session only', async () => {
    const { team } = instance.root.missions;
    const added = await team.addMember(seeded.ada, missionId, { email: seeded.bob.email });
    const member = await team.generateToken(seeded.bob, missionId);
    const named = await team.createNamedToken(seeded.ada, missionId, 'CI runner');
    if (!added.ok || !member.ok || !named.ok) throw new Error('the team was not set up');
    for (const token of [missionToken, member.token.secret, named.token.secret]) {
      expect((await rpc(EXECUTION_URL, bearer(token))).response.status).toBe(200);
      const inbox = await instance.root.requests.handlers.inbox(
        new Request(`${PUBLIC_URL}/api/requests`, {
          headers: { ...bearer(token), cookie: `${SESSION_COOKIE}=${sessionId}` },
        }),
      );
      expect(inbox.status).toBe(403);
      expect(await inbox.json()).toMatchObject({
        error: 'wrong-credential-kind',
        presented: 'mission-token',
        expected: 'human-session',
      });
    }
  });

  it('the retired management door opens to no credential: 404 with a hint, whatever is presented', async () => {
    for (const headers of [
      bearer(missionToken),
      { cookie: `${SESSION_COOKIE}=${sessionId}` },
      {} as Record<string, string>,
    ]) {
      const response = await toolsList(instance, MANAGEMENT_URL, headers);
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ error: 'management-door-retired' });
    }
  });
});
