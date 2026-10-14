/**
 * Mission members and per-holder tokens over the real root (spec §0 "Mission
 * member", "Mission token"; §7.9 bis; ADR mission-members-and-per-holder-tokens).
 *
 * What is proven here, each on the service and on the HTTP handlers where the
 * rule is the handler's:
 *
 *   - the creator adds and removes members; a member generates, rotates and
 *     revokes their OWN token; the creator creates named tokens and revokes any;
 *   - a member reads and uses the mission and changes nothing: not the mission,
 *     not its gates, not its members, not its requests;
 *   - the creator never sees a member's secret: no answer of any API and no row
 *     of the store carries it (the store keeps a hash);
 *   - a member needs no authority of their own, and `orphaned` keeps looking at
 *     the creator alone;
 *   - every one of these acts leaves its administrative entry.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { GatewayRoot } from '../../../src/server/compose/root';
import type {
  BootstrapKit,
  MissionDraft,
  MissionTeam,
  MissionTeamService,
} from '../../../src/server/missions';
import type { MissionRecord, UserRecord } from '../../../src/server/store/types';
import {
  buildTestRoot,
  PUBLIC_URL,
  seedInstance,
  sessionHeaders,
  type SeededInstance,
} from './support';

const SECRET_SHAPE = /^vbn_live_[A-Za-z0-9]{8}_[A-Za-z0-9]{32}$/;
const READ = 'github.code-read';

describe('missions: members and per-holder tokens', () => {
  let root: GatewayRoot;
  let seeded: SeededInstance;
  let team: MissionTeamService;
  let ada: UserRecord;
  let bob: UserRecord;
  let carol: UserRecord;
  let mission: MissionRecord;
  /** The secret of the token the mission was born with: Ada's. */
  let adaSecret: string;

  beforeEach(async () => {
    root = await buildTestRoot();
    seeded = await seedInstance(root);
    ({ ada, bob } = seeded);
    carol = await root.store.users.upsertFromIdp({
      issuer: 'http://idp.test',
      subject: 'idp|carol',
      email: 'carol@example.com',
    });
    team = root.missions.team;
    const issued = await root.missions.service.issue(ada, draft());
    if (!issued.ok) throw new Error(`issue refused: ${JSON.stringify(issued)}`);
    mission = issued.mission;
    adaSecret = issued.token.secret;
  });
  afterEach(async () => {
    await root.close();
  });

  function draft(overrides: Partial<MissionDraft> = {}): MissionDraft {
    return {
      name: 'Ship the billing page',
      connections: [{ connection_id: seeded.github.connection.id, preset: 'developer' }],
      period: { kind: 'recurring', length_seconds: 86_400 },
      expires_at: null,
      ...overrides,
    };
  }

  async function addBob(): Promise<void> {
    const added = await team.addMember(ada, mission.id, { email: bob.email });
    if (!added.ok) throw new Error(`add refused: ${added.reason}`);
  }

  async function bobToken(): Promise<{ secret: string; prefix: string; kit: BootstrapKit }> {
    const generated = await team.generateToken(bob, mission.id);
    if (!generated.ok) throw new Error(`generate refused: ${generated.reason}`);
    return { ...generated.token, kit: generated.kit };
  }

  const teamOf = async (user: UserRecord): Promise<MissionTeam> => {
    const view = await team.team(user, mission.id);
    if (!view) throw new Error('expected the team');
    return view;
  };

  const adminActs = async (): Promise<string[]> =>
    (await root.store.audit.list({ kind: 'admin' })).flatMap((e) =>
      e.kind === 'admin' && e.object.id === mission.id ? [e.act] : [],
    );

  // ── Members ───────────────────────────────────────────────────────────────

  describe('members', () => {
    it('the creator is a member by construction; adding a user shares the mission with them', async () => {
      expect((await teamOf(ada)).members).toEqual([
        {
          user_id: ada.id,
          email: ada.email,
          role: 'creator',
          added_at: null,
          active: true,
          has_token: true,
        },
      ]);
      // Before: the mission does not exist for Bob.
      expect(await root.missions.service.get(bob, mission.id)).toBeNull();
      expect(await team.team(bob, mission.id)).toBeNull();
      expect(await root.missions.service.list(bob)).toEqual([]);

      const added = await team.addMember(ada, mission.id, { email: bob.email });
      expect(added).toMatchObject({
        ok: true,
        member: { user_id: bob.id, email: bob.email, role: 'member', has_token: false },
      });

      // After: Bob finds it among the missions shared with him, marked as such.
      const list = await root.missions.service.list(bob);
      expect(list.map((m) => [m.mission.id, m.role, m.creator.email, m.token])).toEqual([
        [mission.id, 'member', ada.email, null],
      ]);
      // Ada's own list is unchanged: it is hers.
      expect((await root.missions.service.list(ada)).map((m) => m.role)).toEqual(['creator']);
      expect((await teamOf(bob)).members.map((m) => [m.email, m.role])).toEqual([
        [ada.email, 'creator'],
        [bob.email, 'member'],
      ]);
      expect(await adminActs()).toEqual(['mission-issued', 'mission-member-added']);
    });

    it('offers the creator the active users who are not on the mission yet, and a member nobody', async () => {
      expect((await teamOf(ada)).candidates.map((c) => c.email)).toEqual([bob.email, carol.email]);
      await addBob();
      expect((await teamOf(ada)).candidates.map((c) => c.email)).toEqual([carol.email]);
      expect((await teamOf(bob)).candidates).toEqual([]);
      // A deactivated user is not a candidate.
      await root.store.users.markRemoved(carol.id);
      expect((await teamOf(ada)).candidates).toEqual([]);
    });

    it('adds only an active user of the instance, once', async () => {
      expect(await team.addMember(ada, mission.id, { email: 'nobody@example.com' })).toEqual({
        ok: false,
        reason: 'user-not-found',
      });
      expect(await team.addMember(ada, mission.id, { email: ada.email })).toEqual({
        ok: false,
        reason: 'already-member',
      });
      await addBob();
      expect(await team.addMember(ada, mission.id, { email: bob.email })).toEqual({
        ok: false,
        reason: 'already-member',
      });
      await root.store.users.markRemoved(carol.id);
      expect(await team.addMember(ada, mission.id, { email: carol.email })).toEqual({
        ok: false,
        reason: 'user-not-found',
      });
      // Nothing was written for the refusals.
      expect(await adminActs()).toEqual(['mission-issued', 'mission-member-added']);
    });

    it('nobody is added to a revoked mission', async () => {
      await root.missions.service.revoke(ada, mission.id);
      expect(await team.addMember(ada, mission.id, { email: bob.email })).toEqual({
        ok: false,
        reason: 'inactive',
        state: 'revoked',
      });
    });

    it('a member needs no authority of their own: the mission is grounded in its creator', async () => {
      // Bob owns nothing and was shared nothing.
      expect(await root.missions.service.issuanceContext(bob)).toEqual([]);
      await addBob();
      const detail = await root.missions.service.get(bob, mission.id);
      expect(detail?.state.kind).toBe('active');
      expect((await bobToken()).secret).toMatch(SECRET_SHAPE);

      // The creator loses the authority: the mission is orphaned for every holder...
      await root.store.connections.revoke(seeded.github.connection.id);
      expect((await root.missions.service.get(bob, mission.id))?.state.kind).toBe('orphaned');
      // ...and a member cannot generate a token for a mission that serves no call.
      expect(await team.generateToken(bob, mission.id)).toEqual({
        ok: false,
        reason: 'inactive',
        state: 'orphaned',
      });
    });

    it('removing a member revokes their token, takes the mission away from them, and leaves the others', async () => {
      await addBob();
      const bobs = await bobToken();
      expect(await root.missions.service.verifyToken(bobs.secret)).toMatchObject({
        outcome: 'verified',
        token: { holder: { kind: 'member', user_id: bob.id, display: bob.email } },
      });

      expect(await team.removeMember(ada, mission.id, bob.id)).toEqual({
        ok: true,
        user_id: bob.id,
        token_revoked: true,
      });
      expect(await root.missions.service.verifyToken(bobs.secret)).toMatchObject({
        outcome: 'retired',
        reason: 'holder-removed',
      });
      expect(await root.missions.service.verifyToken(adaSecret)).toMatchObject({
        outcome: 'verified',
      });
      expect(await root.missions.service.get(bob, mission.id)).toBeNull();
      expect(await root.missions.service.list(bob)).toEqual([]);
      expect(await team.generateToken(bob, mission.id)).toEqual({ ok: false, reason: 'not-found' });
      expect(await team.removeMember(ada, mission.id, bob.id)).toEqual({
        ok: false,
        reason: 'not-a-member',
      });
      // The creator is not a row: they cannot be removed.
      expect(await team.removeMember(ada, mission.id, ada.id)).toEqual({
        ok: false,
        reason: 'not-a-member',
      });
      expect((await adminActs()).slice(-2)).toEqual([
        'mission-token-issued',
        'mission-member-removed',
      ]);
      const removal = (await root.store.audit.list({ kind: 'admin' })).at(-1);
      expect(removal).toMatchObject({
        before: { member_user_id: bob.id, member_email: bob.email },
        after: { token_revoked_prefix: bobs.prefix },
      });
    });

    it('a member added again starts with no token: the old one stays dead', async () => {
      await addBob();
      const old = await bobToken();
      await team.removeMember(ada, mission.id, bob.id);
      await addBob();
      expect((await teamOf(bob)).my_token).toBeNull();
      // Member again, but the token was revoked with the removal.
      expect(await root.missions.service.verifyToken(old.secret)).toMatchObject({
        outcome: 'retired',
        reason: 'revoked',
      });
      const fresh = await bobToken();
      expect(fresh.secret).not.toBe(old.secret);
      expect((await root.missions.service.verifyToken(fresh.secret)).outcome).toBe('verified');
    });
  });

  // ── Tokens ────────────────────────────────────────────────────────────────

  describe('tokens', () => {
    it('a member generates their own token, shown once with the kit; rotating retires theirs alone', async () => {
      await addBob();
      const first = await team.generateToken(bob, mission.id);
      if (!first.ok) throw new Error('generate refused');
      expect(first.rotated).toBe(false);
      expect(first.token.secret).toMatch(SECRET_SHAPE);
      // The kit is the mission's, personalised with his token.
      expect(first.kit.reveals_secret).toBe(true);
      expect(first.kit.env).toContain(first.token.secret);
      expect(first.kit.agent_instructions).toContain('Ship the billing page');
      expect(first.kit.agent_instructions).toContain('### Whose key this is');
      expect(first.kit.mcp_json).not.toContain(first.token.secret);

      const second = await team.generateToken(bob, mission.id);
      if (!second.ok) throw new Error('rotate refused');
      expect(second.rotated).toBe(true);
      expect(await root.missions.service.verifyToken(first.token.secret)).toMatchObject({
        outcome: 'retired',
        reason: 'rotated',
      });
      expect((await root.missions.service.verifyToken(second.token.secret)).outcome).toBe(
        'verified',
      );
      // Ada's token never moved.
      expect((await root.missions.service.verifyToken(adaSecret)).outcome).toBe('verified');
      expect((await adminActs()).slice(-2)).toEqual(['mission-token-issued', 'mission-rotated']);

      // On the page afterwards: the prefix, never the secret.
      const detail = await root.missions.service.get(bob, mission.id);
      expect(detail?.token?.prefix).toBe(second.token.prefix);
      expect(detail?.kit?.reveals_secret).toBe(false);
      expect(JSON.stringify(detail)).not.toContain(second.token.secret);
    });

    it('a creator who revoked their own token is issued one, by either way, under the same act', async () => {
      const own = (await teamOf(ada)).tokens.find((t) => t.holder.label === ada.email);
      expect(await team.revokeToken(ada, mission.id, own?.id ?? '')).toMatchObject({
        already: false,
      });
      // "Rotate token" of the mission header: nothing is replaced, so it is an issue.
      const viaRotate = await root.missions.service.rotate(ada, mission.id);
      if (!viaRotate.ok) throw new Error('rotate refused');
      expect((await adminActs()).at(-1)).toBe('mission-token-issued');

      const again = (await teamOf(ada)).tokens.find((t) => t.holder.label === ada.email);
      await team.revokeToken(ada, mission.id, again?.id ?? '');
      // "Rotate my token" of the team section: the same act for the same situation.
      const viaTeam = await team.generateToken(ada, mission.id);
      if (!viaTeam.ok) throw new Error('generate refused');
      expect((await adminActs()).at(-1)).toBe('mission-token-issued');
    });

    it('the creator rotating their own token leaves every other holder working', async () => {
      await addBob();
      const bobs = await bobToken();
      const ci = await team.createNamedToken(ada, mission.id, 'CI runner');
      if (!ci.ok) throw new Error('named token refused');

      const rotated = await root.missions.service.rotate(ada, mission.id);
      if (!rotated.ok) throw new Error('rotate refused');
      expect(await root.missions.service.verifyToken(adaSecret)).toMatchObject({
        outcome: 'retired',
        reason: 'rotated',
      });
      for (const secret of [rotated.token.secret, bobs.secret, ci.token.secret]) {
        expect((await root.missions.service.verifyToken(secret)).outcome).toBe('verified');
      }
      // The team service's "rotate my token" is the same act for the creator.
      const again = await team.generateToken(ada, mission.id);
      expect(again).toMatchObject({ ok: true, rotated: true });
      expect((await root.missions.service.verifyToken(bobs.secret)).outcome).toBe('verified');
    });

    it('the creator creates a named token for a machine; a name identifies one working token', async () => {
      const created = await team.createNamedToken(ada, mission.id, '  CI   runner ');
      if (!created.ok) throw new Error('named token refused');
      expect(created.token.secret).toMatch(SECRET_SHAPE);
      expect(created.kit.env).toContain(created.token.secret);
      expect(await root.missions.service.verifyToken(created.token.secret)).toMatchObject({
        outcome: 'verified',
        token: { holder: { kind: 'named', name: 'CI runner' } },
      });
      expect(await team.createNamedToken(ada, mission.id, 'CI runner')).toEqual({
        ok: false,
        reason: 'name-taken',
      });
      for (const bad of ['', '   ', 'ci@acme.example', '-leading', 'x'.repeat(61), 7, null]) {
        expect(await team.createNamedToken(ada, mission.id, bad), String(bad)).toMatchObject({
          ok: false,
          reason: 'invalid-name',
        });
      }
      const tokens = (await teamOf(ada)).tokens;
      expect(tokens.map((t) => [t.holder.kind, t.holder.label, t.created_by, t.mine])).toEqual([
        ['member', ada.email, ada.email, true],
        ['named', 'CI runner', ada.email, false],
      ]);
      expect(await adminActs()).toEqual(['mission-issued', 'mission-token-issued']);

      // Revoked: the name is free again.
      const [, ci] = tokens;
      expect(await team.revokeToken(ada, mission.id, ci?.id ?? '')).toMatchObject({
        ok: true,
        already: false,
      });
      expect(await team.createNamedToken(ada, mission.id, 'CI runner')).toMatchObject({ ok: true });
    });

    it('a token is revoked on its own, by its holder or by the creator; the others keep working', async () => {
      await addBob();
      const bobs = await bobToken();
      const ci = await team.createNamedToken(ada, mission.id, 'CI runner');
      if (!ci.ok) throw new Error('named token refused');
      const idOf = async (label: string) =>
        (await teamOf(ada)).tokens.find((t) => t.holder.label === label)?.id ?? '';

      // By its holder.
      expect(await team.revokeToken(bob, mission.id, await idOf(bob.email))).toEqual({
        ok: true,
        token_id: expect.any(String) as string,
        already: false,
      });
      expect(await root.missions.service.verifyToken(bobs.secret)).toMatchObject({
        outcome: 'retired',
        reason: 'revoked',
      });
      expect((await teamOf(bob)).my_token).toBeNull();
      // By the creator, any token.
      const ciId = await idOf('CI runner');
      expect(await team.revokeToken(ada, mission.id, ciId)).toMatchObject({ already: false });
      expect(await team.revokeToken(ada, mission.id, ciId)).toMatchObject({ already: true });
      expect((await root.missions.service.verifyToken(ci.token.secret)).outcome).toBe('retired');
      // The mission and Ada's token are untouched.
      expect((await root.missions.service.verifyToken(adaSecret)).outcome).toBe('verified');
      expect((await root.missions.service.get(ada, mission.id))?.state.kind).toBe('active');

      const revocations = (await root.store.audit.list({ kind: 'admin' })).flatMap((e) =>
        e.kind === 'admin' && e.act === 'mission-token-revoked' ? [[e.user_id, e.after]] : [],
      );
      expect(revocations).toEqual([
        [bob.id, { status: 'revoked', reason: 'by-holder' }],
        [ada.id, { status: 'revoked', reason: 'by-creator' }],
      ]);
      // A member who revoked theirs generates a new one.
      expect((await bobToken()).secret).toMatch(SECRET_SHAPE);
    });

    it('revoking the mission revokes every token of every holder', async () => {
      await addBob();
      const bobs = await bobToken();
      const ci = await team.createNamedToken(ada, mission.id, 'CI runner');
      if (!ci.ok) throw new Error('named token refused');
      const revoked = await root.missions.service.revoke(ada, mission.id);
      expect(revoked).toMatchObject({ ok: true, tokensRevoked: 3 });
      expect((await teamOf(ada)).tokens).toEqual([]);
      expect((await teamOf(ada)).issuable).toBe(false);
      for (const secret of [adaSecret, ci.token.secret]) {
        expect(await root.missions.service.verifyToken(secret)).toMatchObject({
          outcome: 'retired',
          reason: 'revoked',
        });
      }
      expect((await root.missions.service.verifyToken(bobs.secret)).outcome).toBe('retired');
      expect(await team.generateToken(bob, mission.id)).toEqual({
        ok: false,
        reason: 'inactive',
        state: 'revoked',
      });
      expect(await team.createNamedToken(ada, mission.id, 'CI runner')).toEqual({
        ok: false,
        reason: 'inactive',
        state: 'revoked',
      });
    });

    it('leaves a session event for each token issued or revoked, once the session exists', async () => {
      const session = await root.store.sessions.getOrCreate(mission.id);
      await addBob();
      const bobs = await bobToken();
      await team.createNamedToken(ada, mission.id, 'CI runner');
      await team.removeMember(ada, mission.id, bob.id);
      const events = await root.store.sessions.listEvents(session.id);
      expect(events.map((e) => [e.kind, e.actorUserId, e.details])).toEqual([
        [
          'rotation',
          bob.id,
          {
            token_prefix: bobs.prefix,
            token_kind: 'member',
            holder: bob.id,
            replaced_prefix: null,
          },
        ],
        [
          'rotation',
          ada.id,
          {
            token_prefix: expect.any(String) as string,
            token_kind: 'named',
            holder: 'CI runner',
            replaced_prefix: null,
          },
        ],
        [
          'revocation',
          ada.id,
          { tokens_revoked: 1, token_prefix: bobs.prefix, token_kind: 'member', holder: bob.id },
        ],
      ]);
    });
  });

  // ── What a member cannot do ───────────────────────────────────────────────

  describe('a member uses the mission as it is', () => {
    beforeEach(async () => {
      await addBob();
      await bobToken();
    });

    it('reads the mission, its policy and its team, with nothing editable', async () => {
      const detail = await root.missions.service.get(bob, mission.id);
      expect(detail).toMatchObject({
        role: 'member',
        creator: { id: ada.id, email: ada.email },
        gates_editable: false,
      });
      expect(detail?.policy.length).toBeGreaterThan(0);
      expect((await root.missions.service.get(ada, mission.id))?.gates_editable).toBe(true);
      const view = await teamOf(bob);
      expect(view.role).toBe('member');
      // His own token is the only one he may revoke.
      expect(view.tokens.map((t) => [t.holder.label, t.mine, t.revocable])).toEqual([
        [ada.email, false, false],
        [bob.email, true, true],
      ]);
    });

    it.each([
      [
        'edit a gate',
        (s: GatewayRoot, m: string, u: UserRecord) =>
          s.missions.service.setGate(u, m, READ, 'approval'),
      ],
      [
        'change its limits',
        (s: GatewayRoot, m: string, u: UserRecord) =>
          s.missions.service.setLimits(u, m, [{ risk_id: READ, quota: 999, rate_limit_max: 1 }]),
      ],
      [
        'rotate the creator’s token',
        (s: GatewayRoot, m: string, u: UserRecord) => s.missions.service.rotate(u, m),
      ],
      [
        'revoke the mission',
        (s: GatewayRoot, m: string, u: UserRecord) => s.missions.service.revoke(u, m),
      ],
      [
        'duplicate the mission',
        (s: GatewayRoot, m: string, u: UserRecord) => s.missions.service.duplicate(u, m),
      ],
      [
        'add a member',
        (s: GatewayRoot, m: string, u: UserRecord) =>
          s.missions.team.addMember(u, m, { email: 'carol@example.com' }),
      ],
      [
        'remove the creator or another member',
        (s: GatewayRoot, m: string, u: UserRecord) => s.missions.team.removeMember(u, m, u.id),
      ],
      [
        'create a named token',
        (s: GatewayRoot, m: string, u: UserRecord) =>
          s.missions.team.createNamedToken(u, m, 'CI runner'),
      ],
    ])('cannot %s: not-found, and nothing is written', async (_what, act) => {
      const before = await snapshot();
      expect(await act(root, mission.id, bob)).toEqual({ ok: false, reason: 'not-found' });
      expect(await snapshot()).toEqual(before);
    });

    it('cannot take the mission as a draft, nor revoke a token that is not theirs', async () => {
      expect(await root.missions.service.draftFrom(bob, mission.id)).toBeNull();
      const adas = (await teamOf(bob)).tokens.find((t) => t.holder.label === ada.email);
      const before = await snapshot();
      expect(await team.revokeToken(bob, mission.id, adas?.id ?? '')).toEqual({
        ok: false,
        reason: 'not-found',
      });
      // Nor a token of another mission through this one.
      const other = await root.missions.service.issue(ada, draft({ name: 'Other' }));
      if (!other.ok) throw new Error('issue refused');
      const [foreign] = await root.store.missions.listTokens(other.mission.id);
      expect(await team.revokeToken(ada, mission.id, foreign?.id ?? '')).toEqual({
        ok: false,
        reason: 'not-found',
      });
      expect((await snapshot()).tokens).toEqual(before.tokens);
    });

    it('cannot see or answer the requests of the mission: they are the creator’s', async () => {
      const riskId = mission.policy[0]?.riskId ?? '';
      const decided = await root.store.sessions.decideAndDecrement(
        { missionId: mission.id, riskIds: [riskId], periodStart: mission.periodAnchor },
        () => ({ allow: true }),
      );
      const request = await root.store.requests.create({
        missionId: mission.id,
        sessionId: decided.session.id,
        kind: 'claim',
        riskId,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      });
      const { service: requests } = root.requests;

      expect(await requests.inbox(bob)).toEqual([]);
      expect(await requests.openCount(bob)).toBe(0);
      expect(await requests.view(bob, request.id)).toEqual({ outcome: 'forbidden' });
      expect(await requests.decide(bob, request.id, { resolution: 'reset-period' })).toEqual({
        ok: false,
        reason: 'forbidden',
      });
      expect(await requests.decideClaim(bob, request.id, { resolution: 'reset-period' })).toEqual({
        ok: false,
        reason: 'forbidden',
      });
      expect((await root.store.requests.getById(request.id))?.state).toBe('open');

      // The creator, and only the creator, has it in their inbox and answers it.
      expect((await requests.inbox(ada)).map((r) => r.id)).toEqual([request.id]);
      expect((await requests.decide(ada, request.id, { resolution: 'reset-period' })).ok).toBe(
        true,
      );
    });

    /** What a refused act must leave untouched. */
    async function snapshot() {
      const stored = await root.store.missions.getById(mission.id);
      return {
        status: stored?.status,
        policy: stored?.policy,
        members: await root.store.missions.listMembers(mission.id),
        tokens: (await root.store.missions.listTokens(mission.id)).map((t) => [t.id, t.status]),
        missions: (await root.store.missions.listForCreator(ada.id)).length,
        audit: (await root.store.audit.list({ kind: 'admin' })).length,
      };
    }
  });

  // ── The creator never sees a member's secret ──────────────────────────────

  describe('the secret of a member token belongs to the member alone', () => {
    it('no answer of any API read by the creator, and no row of the store, carries it', async () => {
      await addBob();
      const bobs = await bobToken();
      const secretPart = bobs.secret.slice(bobs.secret.lastIndexOf('_') + 1);
      expect(secretPart).toHaveLength(32);

      // Everything the creator can read about the mission and its team.
      const readByAda = JSON.stringify([
        await root.missions.service.get(ada, mission.id),
        await root.missions.service.list(ada),
        await team.team(ada, mission.id),
        await root.audit.sessions.get(ada, mission.id),
        await root.audit.query.search(
          { kind: 'user', user: ada, groups: [], isOperator: true },
          {
            missionId: null,
            user: null,
            connectionId: null,
            tool: null,
            decision: null,
            agentLabel: null,
            tokenHolder: null,
            kind: null,
            since: null,
            until: null,
          },
        ),
      ]);
      expect(readByAda).toContain(bobs.prefix);
      expect(readByAda).not.toContain(secretPart);

      // The store: every column of every table, as text.
      const tables = root.store.db
        .prepare<
          [],
          { name: string }
        >("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all();
      expect(tables.length).toBeGreaterThan(20);
      for (const { name } of tables) {
        const rows = JSON.stringify(root.store.db.prepare(`SELECT * FROM ${name}`).all());
        expect(rows, name).not.toContain(secretPart);
      }
      // What is stored is the sha256 digest of it.
      const [row] = (await root.store.missions.listTokens(mission.id)).filter(
        (t) => t.prefix === bobs.prefix,
      );
      expect(row?.hashAlg).toBe('sha256');
      expect(row?.hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('over HTTP: the secret is in the answer to the member who generated it, and in no answer to the creator', async () => {
      await addBob();
      const post = (path: string, headers: Headers, body?: unknown) =>
        new Request(`${PUBLIC_URL}/api/missions/${mission.id}${path}`, {
          method: 'POST',
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      const { handlers } = root.missions;
      const asBob = await sessionHeaders(root, bob);
      const asAda = await sessionHeaders(root, ada);

      const generated = await handlers.generateToken(post('/tokens/mine', asBob), mission.id);
      expect(generated.status).toBe(200);
      expect(generated.headers.get('cache-control')).toBe('no-store');
      const body = (await generated.json()) as {
        token: { secret: string; prefix: string };
        kit: BootstrapKit;
        rotated: boolean;
      };
      expect(body.token.secret).toMatch(SECRET_SHAPE);
      expect(body.rotated).toBe(false);
      expect(body.kit.env).toContain(body.token.secret);
      const secretPart = body.token.secret.slice(body.token.secret.lastIndexOf('_') + 1);

      // Every mutation the creator can make on the team answers without it.
      const answers: string[] = [];
      const named = await handlers.createNamedToken(
        post('/tokens', asAda, { name: 'CI runner' }),
        mission.id,
      );
      expect(named.status).toBe(201);
      answers.push(await named.text());
      const bobsId = (await teamOf(ada)).tokens.find((t) => t.holder.label === bob.email)?.id ?? '';
      const revoked = await handlers.revokeToken(
        post(`/tokens/${bobsId}/revoke`, asAda),
        mission.id,
        bobsId,
      );
      expect(revoked.status).toBe(200);
      answers.push(await revoked.text());
      const removed = await handlers.removeMember(
        post(`/members/${bob.id}/remove`, asAda),
        mission.id,
        bob.id,
      );
      expect(removed.status).toBe(200);
      answers.push(await removed.text());
      const rotated = await handlers.rotate(post('/rotate', asAda), mission.id);
      answers.push(await rotated.text());
      for (const answer of answers) expect(answer).not.toContain(secretPart);
    });
  });

  // ── HTTP statuses ─────────────────────────────────────────────────────────

  describe('HTTP handlers', () => {
    const post = (path: string, headers: Headers, body?: unknown) =>
      new Request(`${PUBLIC_URL}/api/missions/${mission.id}${path}`, {
        method: 'POST',
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });

    it('answers each refusal with its status and a sentence', async () => {
      const { handlers } = root.missions;
      const asAda = await sessionHeaders(root, ada);
      const asBob = await sessionHeaders(root, bob);
      const status = async (response: Promise<Response>) => {
        const res = await response;
        const body = (await res.json()) as { error?: string; message?: string };
        if (res.status >= 400) expect(body.message?.length).toBeGreaterThan(10);
        return [res.status, body.error ?? null];
      };

      // Not a member yet: the mission does not exist for Bob.
      expect(await status(handlers.generateToken(post('/tokens/mine', asBob), mission.id))).toEqual(
        [404, 'not-found'],
      );
      expect(
        await status(handlers.addMember(post('/members', asAda, { mail: 'x' }), mission.id)),
      ).toEqual([400, 'invalid-member']);
      expect(
        await status(
          handlers.addMember(post('/members', asAda, { email: 'nobody@example.com' }), mission.id),
        ),
      ).toEqual([422, 'user-not-found']);
      expect(
        await status(handlers.addMember(post('/members', asAda, { email: bob.email }), mission.id)),
      ).toEqual([201, null]);
      expect(
        await status(handlers.addMember(post('/members', asAda, { email: bob.email }), mission.id)),
      ).toEqual([409, 'already-member']);
      // A member cannot add, remove or name.
      expect(
        await status(
          handlers.addMember(post('/members', asBob, { email: carol.email }), mission.id),
        ),
      ).toEqual([404, 'not-found']);
      expect(
        await status(
          handlers.removeMember(post(`/members/${ada.id}/remove`, asBob), mission.id, ada.id),
        ),
      ).toEqual([404, 'not-found']);
      expect(
        await status(
          handlers.createNamedToken(post('/tokens', asBob, { name: 'CI runner' }), mission.id),
        ),
      ).toEqual([404, 'not-found']);
      expect(
        await status(
          handlers.createNamedToken(post('/tokens', asAda, { name: 'a@b' }), mission.id),
        ),
      ).toEqual([400, 'invalid-name']);
      expect(
        await status(
          handlers.createNamedToken(post('/tokens', asAda, { name: 'CI', extra: 1 }), mission.id),
        ),
      ).toEqual([400, 'invalid-name']);
      expect(
        await status(
          handlers.createNamedToken(post('/tokens', asAda, { name: 'CI runner' }), mission.id),
        ),
      ).toEqual([201, null]);
      expect(
        await status(
          handlers.createNamedToken(post('/tokens', asAda, { name: 'CI runner' }), mission.id),
        ),
      ).toEqual([409, 'name-taken']);
      expect(
        await status(handlers.revokeToken(post('/tokens/none/revoke', asAda), mission.id, 'none')),
      ).toEqual([404, 'not-found']);

      await root.missions.service.revoke(ada, mission.id);
      expect(await status(handlers.generateToken(post('/tokens/mine', asBob), mission.id))).toEqual(
        [409, 'mission-inactive'],
      );
    });

    it('refuses a request with no session, from another origin, or from the bootstrap operator', async () => {
      const { handlers } = root.missions;
      const noSession = new Headers({
        origin: PUBLIC_URL,
        'content-type': 'application/json',
      });
      expect(
        (await handlers.generateToken(post('/tokens/mine', noSession), mission.id)).status,
      ).toBe(401);
      const foreign = await sessionHeaders(root, ada, { origin: 'https://evil.example' });
      expect(
        (await handlers.createNamedToken(post('/tokens', foreign, { name: 'CI' }), mission.id))
          .status,
      ).toBe(403);
      expect((await root.store.missions.listTokens(mission.id)).length).toBe(1);
    });
  });
});
