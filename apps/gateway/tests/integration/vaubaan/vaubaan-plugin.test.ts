/**
 * The `vaubaan` plugin over the real execution door, driven by the official MCP
 * client holding the key of a platform management mission (spec §4.1 bis, §6,
 * §8, §10; ADR platform-management-is-a-plugin-on-the-execution-door).
 *
 * Ada owns the accounts; Bob holds a share of her GitHub account limited
 * to three risks. Each connects their Vaubaan account (one click), issues a
 * platform mission on it and hands its key to an agent; every assertion is
 * about what that agent can do **as its user and no more**, through the same
 * door, budget and audit as any other call.
 */
import type { VaubaanRefusal } from '@vaubaan/plugin-vaubaan';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type {
  AccountsAnswer,
  IssuedMissionAnswer,
  MissionsAnswer,
  PreviewView,
  RevokedMissionAnswer,
  RotatedTokenAnswer,
} from '../../../src/server/vaubaan';
import {
  ADA,
  BOB,
  bearer,
  connectWithToken,
  draftOn,
  EXECUTION_URL,
  MANAGEMENT_URL,
  openVaubaanRig,
  toolsList,
  type Agent,
  type VaubaanRig,
} from './support';

const SHARED = ['github.read-code', 'github.read-meta', 'github.create-pr'] as const;
const NOT_SHARED = 'github.feature-branch-write';
const VAUBAAN_TOOLS = [
  'vaubaan__list_my_accounts',
  'vaubaan__get_catalog',
  'vaubaan__list_my_missions',
  'vaubaan__preview_policy',
  'vaubaan__issue_mission',
  'vaubaan__rotate_mission_token',
  'vaubaan__revoke_mission',
];

type Refused = { readonly error: VaubaanRefusal };

describe('vaubaan plugin — the tools of a platform management mission', () => {
  let rig: VaubaanRig;
  let github: string;

  beforeEach(async () => {
    rig = await openVaubaanRig();
    github = rig.seeded.github.account.id;
  });
  afterEach(() => rig.close());

  /** Ada shares her GitHub account with Bob, limited to `SHARED`. */
  async function shareWithBob(riskIds: readonly string[] = SHARED) {
    return rig.root.shares.service.share(await rig.actor(rig.seeded.ada), github, {
      target: { kind: 'user', email: rig.seeded.bob.email },
      riskIds,
    });
  }

  /** What the execution door answers `tools/list` with this mission token: `ok`, or the refusal. */
  async function executionSays(token: string): Promise<string> {
    const response = await toolsList(rig, EXECUTION_URL, bearer(token));
    if (response.status !== 200) return `http-${response.status}`;
    const body = (await response.json()) as { error?: { data?: { code?: string } } };
    return body.error?.data?.code ?? 'ok';
  }

  async function issue(agent: Agent, draft: Record<string, unknown>) {
    const answer = await agent.call<IssuedMissionAnswer>('issue_mission', draft);
    if (answer.isError) throw new Error(`issue refused: ${answer.text}`);
    return answer.data;
  }

  it('lists the seven tools beside the permission request, each with a description and an input schema', async () => {
    const agent = await rig.agentOf(ADA);
    const { tools } = await agent.client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      [...VAUBAAN_TOOLS, 'vaubaan__request_permission'].sort(),
    );
    for (const tool of tools) {
      expect(tool.description?.length, tool.name).toBeGreaterThan(80);
      expect(tool.inputSchema).toMatchObject({ type: 'object' });
    }
    await agent.close();
  });

  it('the Vaubaan account is one per person: connecting again hands back the same one', async () => {
    const actor = await rig.actor(rig.seeded.ada);
    const first = await rig.root.accounts.service.start(actor, 'vaubaan');
    const second = await rig.root.accounts.service.start(actor, 'vaubaan');
    if (first.kind !== 'connected' || second.kind !== 'connected') throw new Error('one click');
    expect(second.account.id).toBe(first.account.id);
    expect(first.account).toMatchObject({
      provider: 'vaubaan',
      owner: { kind: 'user', id: rig.seeded.ada.id },
      metadata: { credential_kind: 'host' },
    });
    expect(await rig.root.accounts.service.get(actor, first.account.id)).toMatchObject({
      resources: [],
    });
  });

  it('nobody can be given access to a Vaubaan account, nor can it be transferred', async () => {
    const actor = await rig.actor(rig.seeded.ada);
    const started = await rig.root.accounts.service.start(actor, 'vaubaan');
    if (started.kind !== 'connected') throw new Error('one click');
    const context = await rig.root.shares.service.contextFor(actor, started.account.id);
    expect(context.unshareable).toBe('account-personal');
    await expect(
      rig.root.shares.service.share(actor, started.account.id, {
        target: { kind: 'user', email: rig.seeded.bob.email },
        riskIds: ['vaubaan.read-setup'],
      }),
    ).rejects.toMatchObject({ code: 'account-personal' });
    expect(rig.root.accounts.service.transferTargets(actor, started.account)).toEqual([]);
  });

  describe('reading the authority', () => {
    it('an owner sees their accounts, the Vaubaan account among them, with the whole catalog', async () => {
      const agent = await rig.agentOf(ADA);
      const { data } = await agent.call<AccountsAnswer>('list_my_accounts');
      expect(data.accounts.map((c) => c.provider).sort()).toEqual([
        'github',
        'gmail',
        'supabase',
        'vaubaan',
        'vercel',
      ]);
      const gh = data.accounts.find((c) => c.account_id === github)!;
      expect(gh.authority).toMatchObject({ basis: 'owner', whole_catalog: true });
      expect(gh.authority.risk_ids).toContain(NOT_SHARED);
      expect(gh.resources.map((r) => r.ref).sort()).toEqual(['acme/app', 'acme/infra', 'acme/web']);
      await agent.close();
    });

    it('a beneficiary sees the shared account with the exact restriction, and nothing else of the owner', async () => {
      await shareWithBob();
      const agent = await rig.agentOf(BOB);
      const { data } = await agent.call<AccountsAnswer>('list_my_accounts');
      expect(data.accounts.map((c) => c.provider).sort()).toEqual(['github', 'vaubaan']);
      const gh = data.accounts.find((c) => c.provider === 'github')!;
      expect(gh.authority).toEqual({ basis: 'share', risk_ids: [...SHARED], whole_catalog: false });
      await agent.close();
    });

    it('get_catalog reads any shipped catalog, its own included, and refuses an unknown provider', async () => {
      const agent = await rig.agentOf(ADA);
      const own = await agent.call<{ risks: { risk_id: string }[] }>('get_catalog', {
        provider: 'vaubaan',
      });
      expect(own.data.risks.map((r) => r.risk_id)).toContain('vaubaan.mission-issue');
      const unknown = await agent.call<Refused>('get_catalog', { provider: 'nope' });
      expect(unknown.data.error.code).toBe('unknown-provider');
      await agent.close();
    });
  });

  describe('preview and issuing', () => {
    it('preview says what passes and writes nothing', async () => {
      const agent = await rig.agentOf(ADA);
      const before = await rig.root.store.missions.listForCreator(rig.seeded.ada.id);
      const { data, isError } = await agent.call<PreviewView>(
        'preview_policy',
        draftOn(github, ['github.read-code', NOT_SHARED]),
      );
      expect(isError).toBe(false);
      expect(data).toMatchObject({ ok: true, issues: [], uncovered: [] });
      expect(await rig.root.store.missions.listForCreator(rig.seeded.ada.id)).toEqual(before);
      await agent.close();
    });

    it('issues within the authority: the user is the creator, the issuing mission is recorded and audited, the key is revealed once', async () => {
      await shareWithBob();
      const agent = await rig.agentOf(BOB);
      const issued = await issue(agent, draftOn(github, ['github.read-code', 'github.create-pr']));

      expect(issued.mission).toMatchObject({
        name: 'Fix the flaky test',
        creator_user_id: rig.seeded.bob.id,
        issued_by_mission_id: agent.missionId,
      });
      expect(issued.token).toMatchObject({ env_var: 'VAUBAAN_MISSION_TOKEN', shown_once: true });
      expect(issued.token.secret).toMatch(/^vbn_live_/);
      expect(issued.bootstrap_kit.mcp_json).toContain(EXECUTION_URL);
      expect(issued.bootstrap_kit.agent_instructions).toContain('github.create-pr');
      expect(issued.bootstrap_kit.agent_instructions).toContain('Missions prepared by an agent');
      expect(issued.bootstrap_kit.agent_instructions).not.toContain(MANAGEMENT_URL);

      // ── The mission record names the issuing mission; the lists say who prepared it ──
      const record = await rig.root.store.missions.getById(issued.mission.mission_id);
      expect(record).toMatchObject({
        creatorUserId: rig.seeded.bob.id,
        issuedByMissionId: agent.missionId,
        status: 'active',
      });
      const detail = await rig.root.missions.service.get(rig.seeded.bob, issued.mission.mission_id);
      expect(detail?.issued_via).toEqual({
        mission_id: agent.missionId,
        mission_name: 'Platform management',
        client_name: null,
      });

      // ── The audit names the user and the calling mission ──
      const entries = (await rig.adminEntries('mission-issued')).filter(
        (e) => e.object.id === issued.mission.mission_id,
      );
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        user_id: rig.seeded.bob.id,
        via_mission_id: agent.missionId,
      });
      // The call itself is in the calling mission's activity, like any call.
      const calls = await rig.root.store.audit.list({ missionId: agent.missionId });
      expect(calls.some((e) => e.kind === 'call' && e.tool === 'vaubaan__issue_mission')).toBe(
        true,
      );
      // …and the secret is nowhere but in the answer.
      const all = JSON.stringify(await rig.root.store.audit.list({}));
      expect(all).not.toContain(issued.token.secret);
      expect(rig.logs.join('\n')).not.toContain(issued.token.secret);

      // ── The key works on the execution door ──
      const executor = await connectWithToken(rig, EXECUTION_URL, issued.token.secret);
      const callable = (await executor.listTools()).tools.map((tool) => tool.name);
      expect(callable.some((name) => name.startsWith('github__'))).toBe(true);
      expect(callable.some((name) => VAUBAAN_TOOLS.includes(name))).toBe(false);
      await executor.close();

      // ── The agent reads it back, marked as its own ──
      const listed = await agent.call<MissionsAnswer>('list_my_missions', {
        mission_id: issued.mission.mission_id,
      });
      expect(listed.data.missions[0]).toMatchObject({
        mission_id: issued.mission.mission_id,
        issued_via: { mission_id: agent.missionId, this_mission: true },
      });
      expect(listed.text).not.toContain(issued.token.secret);
      await agent.close();
    });

    it('refuses a draft beyond the authority, whole, with the uncovered list — and issues nothing', async () => {
      await shareWithBob();
      const agent = await rig.agentOf(BOB);
      const before = (await rig.root.store.missions.listForCreator(rig.seeded.bob.id)).length;
      const answer = await agent.call<Refused>(
        'issue_mission',
        draftOn(github, ['github.read-code', NOT_SHARED]),
      );
      expect(answer.isError).toBe(true);
      expect(answer.data.error).toMatchObject({
        code: 'draft-refused',
        uncovered: [{ account_id: github, provider: 'github', risk_ids: [NOT_SHARED] }],
      });
      expect(await rig.root.store.missions.listForCreator(rig.seeded.bob.id)).toHaveLength(before);
      await agent.close();
    });

    it('a mission issued here never carries a Vaubaan account (the self rule)', async () => {
      const agent = await rig.agentOf(ADA);
      const before = (await rig.root.store.missions.listForCreator(rig.seeded.ada.id)).length;
      for (const vaubaan of [{ account_id: agent.accountId }, { provider: 'vaubaan' }]) {
        const answer = await agent.call<Refused>('issue_mission', {
          name: 'A second platform agent',
          accounts: [{ ...vaubaan, trust_levels: { read: 'careful' } }],
          period: { kind: 'one-off' },
          expires_at: null,
        });
        expect(answer.isError).toBe(true);
        expect(answer.data.error.code).toBe('vaubaan-account-not-allowed');
      }
      expect(await rig.root.store.missions.listForCreator(rig.seeded.ada.id)).toHaveLength(before);
      await agent.close();
    });
  });

  describe('rotating and revoking', () => {
    it('rotates the key of a mission it issued: the old one stops, the entry names the calling mission', async () => {
      const agent = await rig.agentOf(ADA);
      const issued = await issue(agent, draftOn(github, ['github.read-code']));
      const rotated = await agent.call<RotatedTokenAnswer>('rotate_mission_token', {
        mission_id: issued.mission.mission_id,
      });
      expect(rotated.isError).toBe(false);
      expect(rotated.data.token.secret).not.toBe(issued.token.secret);
      expect(await executionSays(issued.token.secret)).toBe('http-401');
      expect(await executionSays(rotated.data.token.secret)).toBe('ok');
      const [entry] = await rig.adminEntries('mission-rotated');
      expect(entry).toMatchObject({
        user_id: rig.seeded.ada.id,
        object: { type: 'mission', id: issued.mission.mission_id },
        via_mission_id: agent.missionId,
      });
      await agent.close();
    });

    it('rotates only what this mission issued: the user’s own mission and another mission’s are refused, their keys keep working', async () => {
      const human = await rig.root.missions.service.issue(
        rig.seeded.ada,
        draftOn(github, ['github.read-code', NOT_SHARED]) as never,
      );
      if (!human.ok) throw new Error('the human issuance was refused');
      const first = await rig.agentOf(ADA);
      const second = await rig.agentOf(ADA);
      expect(second.accountId).toBe(first.accountId);
      const byFirst = await issue(first, draftOn(github, ['github.read-code']));
      for (const missionId of [human.mission.id, byFirst.mission.mission_id]) {
        const answer = await second.call<Refused>('rotate_mission_token', {
          mission_id: missionId,
        });
        expect(answer.data.error, missionId).toMatchObject({
          code: 'mission-not-issued-here',
          mission_id: missionId,
        });
        expect(answer.text).not.toContain('vbn_live_');
      }
      expect(await rig.adminEntries('mission-rotated')).toEqual([]);
      expect(await executionSays(human.token.secret)).toBe('ok');
      expect(await executionSays(byFirst.token.secret)).toBe('ok');
      // Ending a mission enlarges nothing: revoke still reaches the human's mission.
      const revoked = await second.call<RevokedMissionAnswer>('revoke_mission', {
        mission_id: human.mission.id,
      });
      expect(revoked.data).toMatchObject({ state: 'revoked', already_revoked: false });
      await first.close();
      await second.close();
    });

    it('never rotates nor revokes itself, whatever its policy allows', async () => {
      const agent = await rig.agentOf(ADA);
      for (const tool of ['rotate_mission_token', 'revoke_mission']) {
        const answer = await agent.call<Refused>(tool, { mission_id: agent.missionId });
        expect(answer.data.error, tool).toMatchObject({
          code: 'self-not-allowed',
          mission_id: agent.missionId,
        });
      }
      expect(await executionSays(agent.token)).toBe('ok');
      expect((await rig.root.store.missions.getById(agent.missionId))?.status).toBe('active');
      await agent.close();
    });

    it('revokes a mission, once: the entry names the calling mission, a second call changes nothing', async () => {
      const agent = await rig.agentOf(ADA);
      const issued = await issue(agent, draftOn(github, ['github.read-code']));
      const revoked = await agent.call<RevokedMissionAnswer>('revoke_mission', {
        mission_id: issued.mission.mission_id,
      });
      expect(revoked.data).toEqual({
        mission_id: issued.mission.mission_id,
        state: 'revoked',
        tokens_revoked: 1,
        already_revoked: false,
      });
      expect(await executionSays(issued.token.secret)).toBe('mission-inactive');
      const again = await agent.call<RevokedMissionAnswer>('revoke_mission', {
        mission_id: issued.mission.mission_id,
      });
      expect(again.data).toMatchObject({ already_revoked: true, tokens_revoked: 0 });
      const entries = await rig.adminEntries('mission-revoked');
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ via_mission_id: agent.missionId });
      await agent.close();
    });

    it('a mission of another user does not exist for the agent: not read, not rotated, not revoked', async () => {
      const ada = await rig.agentOf(ADA);
      const issued = await issue(ada, draftOn(github, ['github.read-code']));
      const bob = await rig.agentOf(BOB);
      for (const tool of ['list_my_missions', 'rotate_mission_token', 'revoke_mission']) {
        const answer = await bob.call<Refused>(tool, { mission_id: issued.mission.mission_id });
        expect(answer.data.error.code, tool).toBe('mission-not-found');
      }
      expect(await executionSays(issued.token.secret)).toBe('ok');
      await ada.close();
      await bob.close();
    });
  });

  describe('the door decides first, like for any service', () => {
    it('at Careful, issuing asks the person first; reading runs freely', async () => {
      const agent = await rig.agentOf(ADA, {
        read: 'careful',
        prepare: 'careful',
        rotate: 'careful',
        stop: 'careful',
      });
      expect((await agent.call('list_my_accounts')).isError).toBe(false);
      const asked = await agent.call('issue_mission', draftOn(github, ['github.read-code']));
      expect(asked.protocolError).toBe(true);
      expect(asked.code).toBe('approval-required');
      expect(await rig.adminEntries('mission-issued')).toHaveLength(1); // the platform mission
      await agent.close();
    });

    it('a mission without the read macro-action is refused the reads, by the door', async () => {
      const agent = await rig.agentOf(ADA, { prepare: 'autonomous' });
      const refused = await agent.call('list_my_missions');
      expect(refused.protocolError).toBe(true);
      expect(refused.code).toBe('risk-not-accepted');
      await agent.close();
    });

    it('the provider tools of another service are not reachable with the platform key', async () => {
      const agent = await rig.agentOf(ADA);
      const names = await agent.toolNames();
      expect(names.some((name) => name.startsWith('github__'))).toBe(false);
      const answer = await agent.call('github__list_repositories', {});
      expect(answer.isError).toBe(true);
      await agent.close();
    });

    it('a teammate’s key on the platform mission is refused: only the creator acts in their name', async () => {
      const agent = await rig.agentOf(ADA);
      const { team } = rig.root.missions;
      expect(
        (await team.addMember(rig.seeded.ada, agent.missionId, { email: rig.seeded.bob.email })).ok,
      ).toBe(true);
      const bobs = await team.generateToken(rig.seeded.bob, agent.missionId);
      if (!bobs.ok) throw new Error('generate refused');
      const client = await connectWithToken(rig, EXECUTION_URL, bobs.token.secret);
      const result = await client.callTool({ name: 'vaubaan__list_my_missions', arguments: {} });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: 'teammate-key-not-allowed' },
      });
      await client.close();
      await agent.close();
    });

    it('disconnecting the Vaubaan account stops the agent at its next call', async () => {
      const agent = await rig.agentOf(ADA);
      await rig.root.accounts.service.revoke(await rig.actor(rig.seeded.ada), agent.accountId);
      const answer = await agent.call('list_my_missions');
      expect(answer.isError).toBe(true);
      expect(await executionSays(agent.token)).not.toBe('ok');
      await agent.close();
    });
  });

  it('the retired management door answers 404 with a hint to the new way', async () => {
    const response = await toolsList(rig, MANAGEMENT_URL, bearer('anything'));
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: 'management-door-retired',
      hint: expect.stringContaining('vaubaan__list_my_accounts') as string,
    });
  });
});
