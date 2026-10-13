/**
 * The management door over real HTTP handlers, driven by the official MCP
 * client holding a delegated token (spec §4.1 bis, §7.10, §10 "OAuth
 * delegation then issuance of a mission by an MCP client within the user's
 * authority and refusal beyond it").
 *
 * Ada owns the connections; Bob holds a share of her GitHub connection limited
 * to three risks. Each of them delegates to an agent; every assertion is about
 * what that agent can do **as its user and no more**.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MemoryRateLimiter } from '../../../src/server/compose/memory';
import { MANAGEMENT_RATE_KEY_PREFIX } from '../../../src/server/compose/management';
import type { RateLimiter } from '../../../src/server/compose/ports';
import {
  MANAGEMENT_MUTATIONS_PER_WINDOW,
  MANAGEMENT_REQUESTS_PER_WINDOW,
  MANAGEMENT_TOOL_NAMES,
  type CatalogView,
  type ConnectionsAnswer,
  type IssuedMissionAnswer,
  type ManagementRefusal,
  type MissionsAnswer,
  type PreviewView,
  type RevokedMissionAnswer,
  type RotatedTokenAnswer,
} from '../../../src/server/management';
import { bearer, toolsList } from '../oauth-as/support';
import {
  ADA,
  BOB,
  connectWithToken,
  draftOn,
  EXECUTION_URL,
  MANAGEMENT_URL,
  openManagementRig,
  type Agent,
  type ManagementRig,
} from './support';

const SHARED = ['github.read-code', 'github.read-meta', 'github.create-pr'] as const;
const NOT_SHARED = 'github.feature-branch-write';

type Refused = { readonly error: ManagementRefusal };

describe('management door — tools of a delegated agent', () => {
  let rig: ManagementRig;
  let github: string;
  let supabase: string;

  beforeEach(async () => {
    rig = await openManagementRig();
    github = rig.seeded.github.connection.id;
    supabase = rig.seeded.supabase.connection.id;
  });
  afterEach(() => rig.close());

  /** Ada shares her GitHub connection with Bob, limited to `SHARED`. */
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

  it('lists exactly the seven tools, each with a description and an input schema', async () => {
    const agent = await rig.agentOf(ADA);
    const { tools } = await agent.client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([...MANAGEMENT_TOOL_NAMES]);
    for (const tool of tools) {
      expect(tool.description?.length, tool.name).toBeGreaterThan(80);
      expect(tool.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
    }
    expect(agent.client.getInstructions()).toContain('explicit RiskIds only');
    await agent.close();
  });

  describe('reading the authority', () => {
    it('an owner sees their connections with the whole catalog, resources and presets', async () => {
      const agent = await rig.agentOf(ADA);
      const { data } = await agent.call<ConnectionsAnswer>('list_my_connections');
      // Gmail is an experimental plugin: hidden unless asked.
      expect(data.connections.map((c) => c.provider).sort()).toEqual([
        'github',
        'supabase',
        'vercel',
      ]);
      expect(data.hidden_experimental).toBe(1);

      const gh = data.connections.find((c) => c.connection_id === github)!;
      expect(gh.authority).toMatchObject({ basis: 'owner', whole_catalog: true });
      expect(gh.authority.risk_ids).toContain(NOT_SHARED);
      expect(gh.resources.map((r) => r.ref).sort()).toEqual(['acme/app', 'acme/infra', 'acme/web']);
      expect(gh.presets.map((p) => p.id)).toEqual(['read-only', 'developer', 'release-manager']);
      expect(gh.presets.every((p) => p.within_authority)).toBe(true);

      const all = await agent.call<ConnectionsAnswer>('list_my_connections', {
        include_experimental: true,
      });
      expect(all.data.connections.map((c) => c.provider)).toContain('gmail');
      expect(all.data.hidden_experimental).toBe(0);
      await agent.close();
    });

    it('says which environment-qualified risks are usable: labelled resources carry them, unlabelled ones refuse them', async () => {
      const agent = await rig.agentOf(ADA);
      const { data } = await agent.call<ConnectionsAnswer>('list_my_connections');
      const sb = data.connections.find((c) => c.connection_id === supabase)!;
      expect(sb.resources).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ ref: 'stgprojectref', env: 'staging' }),
          expect.objectContaining({ ref: 'prdprojectref', env: 'prod' }),
        ]),
      );
      expect(sb.env_qualified_risks).toMatchObject({
        derives_env: false,
        unlabelled_resources: [],
      });
      expect([...sb.env_qualified_risks.labelled_envs].sort()).toEqual(['prod', 'staging']);
      expect(sb.env_qualified_risks.usable_risk_ids).toContain('supabase[staging].row-write-one');
      // No resource of the connection is labelled `preview`.
      expect(sb.env_qualified_risks.unusable_risk_ids).toContain('supabase[preview].row-write-one');

      // GitHub repositories carry no label, and the catalog has no env-qualified risk to lose.
      const gh = data.connections.find((c) => c.connection_id === github)!;
      expect(gh.env_qualified_risks.unlabelled_resources).toHaveLength(3);
      // Vercel reads the environment from the call: no label is needed.
      const vercel = data.connections.find((c) => c.provider === 'vercel')!;
      expect(vercel.env_qualified_risks.derives_env).toBe(true);
      expect(vercel.env_qualified_risks.unusable_risk_ids).toEqual([]);
      await agent.close();
    });

    it('a beneficiary sees the shared connection with the exact restriction, and nothing else of the owner', async () => {
      await shareWithBob();
      const agent = await rig.agentOf(BOB);
      const { data } = await agent.call<ConnectionsAnswer>('list_my_connections', {
        include_experimental: true,
      });
      expect(data.connections).toHaveLength(1);
      const [gh] = data.connections;
      expect(gh).toMatchObject({ connection_id: github, provider: 'github' });
      expect(gh?.authority).toEqual({
        basis: 'share',
        risk_ids: ['github.read-code', 'github.read-meta', 'github.create-pr'],
        whole_catalog: false,
      });
      const presets = Object.fromEntries((gh?.presets ?? []).map((p) => [p.id, p]));
      expect(presets['read-only']).toMatchObject({ within_authority: true });
      expect(presets.developer?.within_authority).toBe(false);
      expect(presets.developer?.outside_authority).toContain(NOT_SHARED);
      await agent.close();
    });

    it('someone who holds nothing sees nothing', async () => {
      const agent = await rig.agentOf(BOB);
      const { data } = await agent.call<ConnectionsAnswer>('list_my_connections', {
        include_experimental: true,
      });
      expect(data).toEqual({ connections: [], hidden_experimental: 0 });
      expect((await agent.call<MissionsAnswer>('list_my_missions')).data.missions).toEqual([]);
      await agent.close();
    });

    it('get_catalog returns explicit ids with the presets, flagged against the authority on a connection', async () => {
      await shareWithBob();
      const agent = await rig.agentOf(BOB);
      const plain = await agent.call<CatalogView>('get_catalog', { provider: 'github' });
      expect(plain.isError).toBe(false);
      expect(plain.data.connection_id).toBeNull();
      expect(plain.data.risks.map((r) => r.risk_id)).toContain(NOT_SHARED);
      expect(plain.data.risks.every((r) => r.in_my_authority === undefined)).toBe(true);
      expect(plain.data.risks.every((r) => !r.risk_id.includes('*'))).toBe(true);
      const developer = plain.data.presets.find((p) => p.id === 'developer');
      expect(developer?.entries[0]).toMatchObject({
        risk_id: 'github.read-code',
        quota: expect.any(Number) as number,
        rate_limit: {
          max: expect.any(Number) as number,
          window_seconds: expect.any(Number) as number,
        },
      });

      const flagged = await agent.call<CatalogView>('get_catalog', {
        provider: 'github',
        connection_id: github,
      });
      const held = flagged.data.risks.filter((r) => r.in_my_authority).map((r) => r.risk_id);
      expect(held).toEqual(['github.read-code', 'github.read-meta', 'github.create-pr']);

      // Env-scoped risks are one id per environment.
      const sb = await agent.call<CatalogView>('get_catalog', { provider: 'supabase' });
      expect(sb.data.risks.map((r) => r.risk_id)).toEqual(
        expect.arrayContaining(['supabase[staging].row-write-one', 'supabase[prod].row-write-one']),
      );
      await agent.close();
    });

    it('get_catalog refuses an unknown provider and a connection that is not the user’s', async () => {
      const agent = await rig.agentOf(BOB);
      const unknown = await agent.call<Refused>('get_catalog', { provider: 'nope' });
      expect(unknown.isError).toBe(true);
      expect(unknown.data.error).toMatchObject({ code: 'unknown-provider' });
      expect(unknown.data.error.providers).toContain('github');
      // Ada's connection, which Bob holds nothing on.
      const foreign = await agent.call<Refused>('get_catalog', {
        provider: 'github',
        connection_id: github,
      });
      expect(foreign.data.error).toMatchObject({ code: 'unknown-connection' });
      await agent.close();
    });
  });

  describe('preview', () => {
    it('says what passes and writes nothing', async () => {
      const agent = await rig.agentOf(ADA);
      const { data, isError } = await agent.call<PreviewView>(
        'preview_policy',
        draftOn(github, ['github.read-code', NOT_SHARED]),
      );
      expect(isError).toBe(false);
      expect(data).toMatchObject({ ok: true, issues: [], uncovered: [] });
      expect(data.policy.map((entry) => entry.risk_id).sort()).toEqual([
        NOT_SHARED,
        'github.read-code',
      ]);
      expect(data.summary.can.length).toBeGreaterThan(0);
      expect(await rig.root.store.missions.listForCreator(rig.seeded.ada.id)).toEqual([]);
      expect(await rig.adminEntries('mission-issued')).toEqual([]);
      await agent.close();
    });

    it('lists what exceeds the user’s authority, and it is an answer, not an error', async () => {
      await shareWithBob();
      const agent = await rig.agentOf(BOB);
      const { data, isError } = await agent.call<PreviewView>(
        'preview_policy',
        draftOn(github, ['github.read-code', NOT_SHARED]),
      );
      expect(isError).toBe(false);
      expect(data.ok).toBe(false);
      expect(data.uncovered).toEqual([
        { connection_id: github, provider: 'github', risk_ids: [NOT_SHARED] },
      ]);
      expect(data.issues.map((issue) => issue.code)).toContain('exceeds-authority');
      await agent.close();
    });

    it('a preset alone is bounded by the authority; an env-qualified id with no labelled resource is refused', async () => {
      await shareWithBob();
      const bob = await rig.agentOf(BOB);
      const preset = await bob.call<PreviewView>('preview_policy', {
        name: 'Review',
        connections: [{ provider: 'github', preset: 'developer' }],
        period: { kind: 'one-off' },
        expires_at: null,
      });
      expect(preset.data.ok).toBe(true);
      expect(preset.data.policy.map((entry) => entry.risk_id).sort()).toEqual([...SHARED].sort());
      expect(
        preset.data.connections[0]?.skipped_from_preset.map((skipped) => skipped.risk_id),
      ).toContain(NOT_SHARED);
      await bob.close();

      const ada = await rig.agentOf(ADA);
      const env = await ada.call<PreviewView>(
        'preview_policy',
        draftOn(supabase, ['supabase[preview].row-write-one']),
      );
      expect(env.data.ok).toBe(false);
      expect(env.data.issues.map((issue) => issue.code)).toContain('unresolvable-env');
      await ada.close();
    });

    it('a draft that is not a draft is refused by the schema, naming the field', async () => {
      const agent = await rig.agentOf(ADA);
      const wildcard = await agent.call('preview_policy', {
        ...draftOn(github, ['github.read-code']),
        accept_all: true,
      });
      expect(wildcard.isError).toBe(true);
      expect(wildcard.text).toContain('accept_all');
      const noBudget = await agent.call<PreviewView>('preview_policy', {
        name: 'No budget',
        connections: [{ connection_id: github, policy: [{ risk_id: 'github.read-code' }] }],
        period: { kind: 'one-off' },
        expires_at: null,
      });
      expect(noBudget.data.ok).toBe(false);
      expect(noBudget.data.issues.map((issue) => issue.code)).toContain('missing-budget');
      // A wildcard is not an id of the catalog.
      const star = await agent.call<PreviewView>('preview_policy', draftOn(github, ['github.*']));
      expect(star.data.ok).toBe(false);
      expect(star.data.issues.map((issue) => issue.code)).toContain('unknown-risk');
      await agent.close();
    });
  });

  describe('issuing', () => {
    it('issues within the authority: the user is the creator, the client is recorded, the token is revealed once with the kit', async () => {
      await shareWithBob();
      const agent = await rig.agentOf(BOB);
      const clientId = agent.delegated.clientId;
      const issued = await issue(agent, draftOn(github, ['github.read-code', 'github.create-pr']));

      expect(issued.mission).toMatchObject({
        name: 'Fix the flaky test',
        creator_user_id: rig.seeded.bob.id,
        issued_via_client_id: clientId,
      });
      expect(issued.token).toMatchObject({
        env_var: 'VAUBAAN_MISSION_TOKEN',
        shown_once: true,
      });
      expect(issued.token.secret).toMatch(/^vbn_live_/);
      expect(issued.bootstrap_kit.env).toContain(issued.token.secret);
      expect(issued.bootstrap_kit.mcp_json).toContain(EXECUTION_URL);
      expect(issued.bootstrap_kit.agent_instructions).toContain('github.create-pr');
      expect(issued.bootstrap_kit.agent_instructions).toContain(MANAGEMENT_URL);
      expect(issued.policy.map((entry) => entry.risk_id).sort()).toEqual([
        'github.create-pr',
        'github.read-code',
      ]);

      // ── The mission record: creator = the delegating user, issued_via = the client ──
      const record = await rig.root.store.missions.getById(issued.mission.mission_id);
      expect(record).toMatchObject({
        creatorUserId: rig.seeded.bob.id,
        delegationId: agent.delegated.delegationId,
        status: 'active',
      });
      const [overview] = await rig.root.missions.service.list(rig.seeded.bob);
      expect(overview?.issuedVia).toEqual({
        delegation_id: agent.delegated.delegationId,
        client_id: clientId,
        client_name: 'Scripted MCP client',
      });
      const detail = await rig.root.missions.service.get(rig.seeded.bob, issued.mission.mission_id);
      expect(detail?.issuedVia?.client_id).toBe(clientId);
      // Ada, who owns the connection, did not issue it.
      expect(await rig.root.missions.service.list(rig.seeded.ada)).toEqual([]);

      // ── The Delegations page lists it under the delegation that issued it ──
      const [view] = await rig.root.oauth.delegations.listFor(rig.seeded.bob);
      expect(view?.missions.map((m) => m.id)).toEqual([issued.mission.mission_id]);

      // ── The audit names the user and the client ──
      const entries = await rig.adminEntries('mission-issued');
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        user_id: rig.seeded.bob.id,
        object: { type: 'mission', id: issued.mission.mission_id },
        delegated_client_id: clientId,
      });
      // …and the secret is nowhere but in the answer.
      expect(JSON.stringify(entries)).not.toContain(issued.token.secret);
      expect(rig.logs.join('\n')).not.toContain(issued.token.secret);

      // ── The token works on the execution door, and only there ──
      const executor = await connectWithToken(rig, EXECUTION_URL, issued.token.secret);
      const callable = (await executor.listTools()).tools.map((tool) => tool.name);
      expect(callable.length).toBeGreaterThan(0);
      expect(callable.every((name) => name.startsWith('github__'))).toBe(true);
      await executor.close();
      const wrongDoor = await toolsList(rig, MANAGEMENT_URL, bearer(issued.token.secret));
      expect(wrongDoor.status).toBe(403);
      expect(await wrongDoor.json()).toMatchObject({
        error: { data: { code: 'wrong-credential-kind', presented: 'mission-token' } },
      });

      // ── The agent reads it back, marked as its own ──
      const listed = await agent.call<MissionsAnswer>('list_my_missions');
      expect(listed.data.missions).toHaveLength(1);
      expect(listed.data.missions[0]).toMatchObject({
        mission_id: issued.mission.mission_id,
        state: 'active',
        orphan: null,
        issued_via: { client_id: clientId, this_client: true },
        session: { period_end: expect.any(String) as string },
      });
      expect(listed.data.missions[0]?.policy).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ risk_id: 'github.read-code', quota: 20, remaining: 20 }),
        ]),
      );
      expect(listed.text).not.toContain(issued.token.secret);
      await agent.close();
    });

    it('refuses a draft beyond the authority, whole, with the uncovered list — and issues nothing', async () => {
      await shareWithBob();
      const agent = await rig.agentOf(BOB);
      const answer = await agent.call<Refused>(
        'issue_mission',
        draftOn(github, ['github.read-code', NOT_SHARED, 'github.merge-protected']),
      );
      expect(answer.isError).toBe(true);
      expect(answer.data.error).toMatchObject({
        code: 'draft-refused',
        uncovered: [
          {
            connection_id: github,
            provider: 'github',
            risk_ids: [NOT_SHARED, 'github.merge-protected'],
          },
        ],
      });
      expect(answer.data.error.hint).toContain('uncovered');
      expect(answer.text).toContain('draft-refused');
      expect(JSON.stringify(answer.data)).not.toContain('vbn_live_');
      expect(await rig.root.store.missions.listForCreator(rig.seeded.bob.id)).toEqual([]);
      expect(await rig.adminEntries('mission-issued')).toEqual([]);
      await agent.close();
    });

    it('the authority is the user’s current one: a share narrowed after the consent narrows what the agent may issue', async () => {
      await shareWithBob();
      const agent = await rig.agentOf(BOB);
      const draft = draftOn(github, ['github.create-pr']);
      expect((await agent.call<PreviewView>('preview_policy', draft)).data.ok).toBe(true);

      await shareWithBob(['github.read-code']);
      const after = await agent.call<Refused>('issue_mission', draft);
      expect(after.data.error.uncovered).toEqual([
        { connection_id: github, provider: 'github', risk_ids: ['github.create-pr'] },
      ]);
      await agent.close();
    });

    it('a connection of somebody else cannot be named, by id or by provider', async () => {
      const agent = await rig.agentOf(BOB);
      for (const connection of [{ connection_id: github }, { provider: 'github' }]) {
        const answer = await agent.call<Refused>('issue_mission', {
          name: 'Not mine',
          connections: [{ ...connection, preset: 'read-only' }],
          period: { kind: 'one-off' },
          expires_at: null,
        });
        expect(answer.isError).toBe(true);
        expect(answer.data.error.code).toBe('draft-refused');
      }
      expect(await rig.root.store.missions.listForCreator(rig.seeded.bob.id)).toEqual([]);
      await agent.close();
    });
  });

  describe('rotating and revoking', () => {
    it('rotates the token of an active mission: the old one stops, the entry names the client', async () => {
      const agent = await rig.agentOf(ADA);
      const issued = await issue(agent, draftOn(github, ['github.read-code']));
      const rotated = await agent.call<RotatedTokenAnswer>('rotate_mission_token', {
        mission_id: issued.mission.mission_id,
      });
      expect(rotated.isError).toBe(false);
      expect(rotated.data.token.secret).toMatch(/^vbn_live_/);
      expect(rotated.data.token.secret).not.toBe(issued.token.secret);
      expect(rotated.data.bootstrap_kit.env).toContain(rotated.data.token.secret);

      expect(await executionSays(issued.token.secret)).toBe('http-401');
      expect(await executionSays(rotated.data.token.secret)).toBe('ok');
      const [entry] = await rig.adminEntries('mission-rotated');
      expect(entry).toMatchObject({
        user_id: rig.seeded.ada.id,
        object: { type: 'mission', id: issued.mission.mission_id },
        delegated_client_id: agent.delegated.clientId,
      });
      await agent.close();
    });

    it('revokes a mission, once: the entry names the client, a second call changes nothing', async () => {
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
      expect(entries[0]).toMatchObject({
        user_id: rig.seeded.ada.id,
        delegated_client_id: agent.delegated.clientId,
      });

      // A revoked mission is not rotated, and is hidden from the default listing.
      const rotate = await agent.call<Refused>('rotate_mission_token', {
        mission_id: issued.mission.mission_id,
      });
      expect(rotate.data.error).toMatchObject({ code: 'mission-inactive', state: 'revoked' });
      expect(await rig.adminEntries('mission-rotated')).toEqual([]);
      const listed = await agent.call<MissionsAnswer>('list_my_missions');
      expect(listed.data).toEqual({ missions: [], hidden_closed: 1 });
      const closed = await agent.call<MissionsAnswer>('list_my_missions', {
        include_closed: true,
      });
      expect(closed.data.missions[0]).toMatchObject({ state: 'revoked', token_prefix: null });
      await agent.close();
    });

    it('an orphaned mission is shown orphaned, is not rotated, comes back with the share, and can be revoked', async () => {
      const { share: created } = await shareWithBob();
      const agent = await rig.agentOf(BOB);
      const issued = await issue(agent, draftOn(github, ['github.read-code']));
      const missionId = issued.mission.mission_id;

      await rig.root.shares.service.revoke(await rig.actor(rig.seeded.ada), created.id);
      const orphaned = await agent.call<MissionsAnswer>('list_my_missions', {
        mission_id: missionId,
      });
      expect(orphaned.data.missions[0]).toMatchObject({
        state: 'orphaned',
        orphan: { cause: 'authority-lost', connection_id: github, can_come_back: true },
        session: null,
      });
      const rotate = await agent.call<Refused>('rotate_mission_token', { mission_id: missionId });
      expect(rotate.isError).toBe(true);
      expect(rotate.data.error).toMatchObject({
        code: 'mission-inactive',
        state: 'orphaned',
        orphan: { cause: 'authority-lost', uncovered: ['github.read-code'] },
      });
      expect(await rig.adminEntries('mission-rotated')).toEqual([]);
      // The token was not replaced: it is the same one that will work again.
      expect(await executionSays(issued.token.secret)).toBe('mission-inactive');

      // The owner shares again: the mission serves calls again and may be rotated.
      await shareWithBob();
      const back = await agent.call<MissionsAnswer>('list_my_missions', { mission_id: missionId });
      expect(back.data.missions[0]).toMatchObject({ state: 'active', orphan: null });
      expect(await executionSays(issued.token.secret)).toBe('ok');

      // Orphaned again, the creator's agent closes it for good.
      const [share] = await rig.root.store.shares.listActiveForTargets(
        [{ kind: 'user', id: rig.seeded.bob.id }],
        github,
      );
      await rig.root.shares.service.revoke(await rig.actor(rig.seeded.ada), share!.id);
      const revoked = await agent.call<RevokedMissionAnswer>('revoke_mission', {
        mission_id: missionId,
      });
      expect(revoked.data).toMatchObject({ state: 'revoked', already_revoked: false });
      expect((await rig.root.store.missions.getById(missionId))?.status).toBe('revoked');
      await agent.close();
    });

    it('a mission of another user does not exist for the agent: not read, not rotated, not revoked', async () => {
      const ada = await rig.agentOf(ADA);
      const issued = await issue(ada, draftOn(github, ['github.read-code']));
      const bob = await rig.agentOf(BOB);
      const missionId = issued.mission.mission_id;
      for (const tool of ['list_my_missions', 'rotate_mission_token', 'revoke_mission']) {
        const answer = await bob.call<Refused>(tool, { mission_id: missionId });
        expect(answer.isError, tool).toBe(true);
        expect(answer.data.error.code, tool).toBe('mission-not-found');
      }
      expect((await rig.root.store.missions.getById(missionId))?.status).toBe('active');
      expect(await executionSays(issued.token.secret)).toBe('ok');
      expect(await rig.adminEntries('mission-revoked')).toEqual([]);
      await ada.close();
      await bob.close();
    });

    it('rotates only what its own delegation issued: the user’s own mission and another delegation’s are refused, their tokens keep working', async () => {
      // The human issues a wide mission in the interface (here: the service, as the page does).
      const human = await rig.root.missions.service.issue(
        rig.seeded.ada,
        draftOn(github, ['github.read-code', NOT_SHARED]) as never,
      );
      if (!human.ok) throw new Error('the human issuance was refused');
      const first = await rig.agentOf(ADA);
      const second = await rig.agentOf(ADA);
      expect(second.delegated.delegationId).not.toBe(first.delegated.delegationId);
      const byFirst = await issue(first, draftOn(github, ['github.read-code']));

      // The human's mission: listed (it is the user's), not rotated.
      const listed = await second.call<MissionsAnswer>('list_my_missions');
      const views = new Map(listed.data.missions.map((m) => [m.mission_id, m.issued_via]));
      expect(views.get(human.mission.id)).toBeNull();
      expect(views.get(byFirst.mission.mission_id)).toMatchObject({ this_delegation: false });

      for (const missionId of [human.mission.id, byFirst.mission.mission_id]) {
        const answer = await second.call<Refused>('rotate_mission_token', {
          mission_id: missionId,
        });
        expect(answer.isError, missionId).toBe(true);
        expect(answer.data.error, missionId).toMatchObject({
          code: 'mission-not-issued-here',
          mission_id: missionId,
        });
        // Nothing of a token is in the refusal.
        expect(answer.text).not.toContain('vbn_live_');
      }
      expect(await rig.adminEntries('mission-rotated')).toEqual([]);
      expect(await executionSays(human.token.secret)).toBe('ok');
      expect(await executionSays(byFirst.token.secret)).toBe('ok');

      // The delegation that issued it rotates it; the human rotates their own in the interface.
      const own = await first.call<RotatedTokenAnswer>('rotate_mission_token', {
        mission_id: byFirst.mission.mission_id,
      });
      expect(own.isError).toBe(false);
      const inInterface = await rig.root.missions.service.rotate(rig.seeded.ada, human.mission.id);
      expect(inInterface.ok).toBe(true);
      // Ending a mission enlarges nothing: revoke still reaches the human's mission.
      const revoked = await second.call<RevokedMissionAnswer>('revoke_mission', {
        mission_id: human.mission.id,
      });
      expect(revoked.data).toMatchObject({ state: 'revoked', already_revoked: false });
      await first.close();
      await second.close();
    });

    it('the mission service refuses a rotation asked in the name of another delegation, whoever calls it', async () => {
      const agent = await rig.agentOf(ADA);
      const issued = await issue(agent, draftOn(github, ['github.read-code']));
      const asked = await rig.root.missions.service.rotate(
        rig.seeded.ada,
        issued.mission.mission_id,
        {
          delegation: { id: 'another-delegation', clientId: agent.delegated.clientId },
        },
      );
      expect(asked).toEqual({ ok: false, reason: 'not-issued-by-delegation' });
      expect(await executionSays(issued.token.secret)).toBe('ok');
      await agent.close();
    });

    it('a revoked delegation stops the agent at its next call', async () => {
      const agent = await rig.agentOf(ADA);
      await rig.root.oauth.delegations.revoke(rig.seeded.ada, agent.delegated.delegationId);
      const response = await toolsList(
        rig,
        MANAGEMENT_URL,
        bearer(agent.delegated.tokens.access_token),
      );
      expect(response.status).toBe(401);
      expect(response.headers.get('www-authenticate')).toContain('invalid_token');
    });
  });
});

describe('management door — what it never exposes', () => {
  let rig: ManagementRig;
  beforeEach(async () => {
    rig = await openManagementRig();
  });
  afterEach(() => rig.close());

  // One name per family of spec §4.1 bis, as an agent would guess them, plus a
  // real provider tool of the execution door.
  const FORBIDDEN = [
    ['answering a request', ['answer_request', 'decide_request', 'grant_claim', 'approve_action']],
    ['gates', ['open_gate', 'set_gate', 'close_gate']],
    ['budgets', ['extend_budget', 'reset_period', 'set_quota', 'replace_policy']],
    [
      'connections',
      ['connect_provider', 'revoke_connection', 'transfer_connection', 'reconnect_connection'],
    ],
    ['shares', ['share_connection', 'revoke_share']],
    ['groups', ['create_group', 'add_group_member']],
    ['tool execution', ['github__list_repositories', 'execute_tool', 'call_tool']],
  ] as const;

  it.each(FORBIDDEN)('%s: no such tool is listed or callable', async (_family, names) => {
    const agent = await rig.agentOf(ADA);
    const listed = await agent.toolNames();
    for (const name of names) {
      expect(listed).not.toContain(name);
      const answer = await agent.call(name, { mission_id: 'x', request_id: 'x' });
      expect(answer.protocolError, name).toBe(true);
      expect(answer.text, name).toMatch(/not found/i);
    }
    await agent.close();
  });

  it('the provider tools of the execution door are not reachable with a delegated token', async () => {
    const agent = await rig.agentOf(ADA);
    const issued = await agent.call<IssuedMissionAnswer>(
      'issue_mission',
      draftOn(rig.seeded.github.connection.id, ['github.read-code']),
    );
    const executor = await connectWithToken(rig, EXECUTION_URL, issued.data.token.secret);
    const [providerTool] = (await executor.listTools()).tools;
    await executor.close();
    expect(providerTool).toBeDefined();

    const viaManagement = await agent.call(providerTool!.name, {});
    expect(viaManagement.protocolError).toBe(true);
    expect(viaManagement.text).toMatch(/not found/i);
    const viaExecution = await toolsList(
      rig,
      EXECUTION_URL,
      bearer(agent.delegated.tokens.access_token),
    );
    expect(viaExecution.status).toBe(403);
    expect(await viaExecution.json()).toMatchObject({
      error: { data: { code: 'wrong-credential-kind', presented: 'delegated-token' } },
    });
    await agent.close();
  });

  it('a mission token or a human session presented at the door gets wrong-credential-kind', async () => {
    const agent = await rig.agentOf(ADA);
    const issued = await agent.call<IssuedMissionAnswer>(
      'issue_mission',
      draftOn(rig.seeded.github.connection.id, ['github.read-code']),
    );
    const mission = await toolsList(rig, MANAGEMENT_URL, bearer(issued.data.token.secret));
    expect(mission.status).toBe(403);
    expect(await mission.json()).toMatchObject({
      error: { data: { code: 'wrong-credential-kind', presented: 'mission-token' } },
    });

    const browser = rig.browser();
    await browser.signIn(ADA);
    const cookie = [...browser.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
    const session = await toolsList(rig, MANAGEMENT_URL, { cookie });
    expect(session.status).toBe(403);
    expect(await session.json()).toMatchObject({
      error: { data: { code: 'wrong-credential-kind', presented: 'human-session' } },
    });
    expect(mission.headers.get('www-authenticate')).toBeNull();
    await agent.close();
  });
});

describe('management door — rate limits per delegation', () => {
  it('the surface limit is per delegation, through the RateLimiter port, on keys of the door', async () => {
    const keys: string[] = [];
    const memory = new MemoryRateLimiter();
    const spy: RateLimiter = {
      take: (key, limit, windowMs) => {
        keys.push(key);
        return memory.take(key, limit, windowMs);
      },
    };
    const rig = await openManagementRig({ deps: { rateLimiter: spy } });
    try {
      const ada = await rig.agentOf(ADA);
      const bob = await rig.agentOf(BOB);
      const mine = `${MANAGEMENT_RATE_KEY_PREFIX}delegation:${ada.delegated.delegationId}`;
      expect(keys).toContain(mine);

      const token = bearer(ada.delegated.tokens.access_token);
      let last = await toolsList(rig, MANAGEMENT_URL, token);
      for (let i = 0; i < MANAGEMENT_REQUESTS_PER_WINDOW && last.status === 200; i += 1) {
        last = await toolsList(rig, MANAGEMENT_URL, token);
      }
      expect(last.status).toBe(429);
      expect(Number(last.headers.get('retry-after'))).toBeGreaterThan(0);
      expect(await last.json()).toMatchObject({
        error: { code: -32002, data: { retry_after_seconds: expect.any(Number) as number } },
      });
      expect(keys.filter((key) => key === mine).length).toBe(MANAGEMENT_REQUESTS_PER_WINDOW + 1);

      // Another delegation is not slowed down.
      expect(
        (await toolsList(rig, MANAGEMENT_URL, bearer(bob.delegated.tokens.access_token))).status,
      ).toBe(200);
      await bob.close();
    } finally {
      await rig.close();
    }
  });

  it('mutations have a budget of their own per delegation; a refused draft does not spend it', async () => {
    const taken = new Map<string, number>();
    const limiter: RateLimiter = {
      take: async (key, limit) => {
        const count = (taken.get(key) ?? 0) + 1;
        taken.set(key, count);
        // The mutation budget of the door is spent after two acts; nothing else is limited.
        const spent = key.endsWith(':mutations') && count > 2;
        return {
          allowed: !spent,
          remaining: spent ? 0 : limit - count,
          retryAfterMs: spent ? 90_000 : 0,
        };
      },
    };
    const rig = await openManagementRig({ deps: { rateLimiter: limiter } });
    try {
      const agent = await rig.agentOf(ADA);
      const github = rig.seeded.github.connection.id;
      const key = `${MANAGEMENT_RATE_KEY_PREFIX}delegation:${agent.delegated.delegationId}:mutations`;

      const refusedDraft = await agent.call('issue_mission', draftOn(github, ['github.nope']));
      expect(refusedDraft.isError).toBe(true);
      expect(taken.get(key)).toBeUndefined();

      const first = await agent.call<IssuedMissionAnswer>(
        'issue_mission',
        draftOn(github, ['github.read-code']),
      );
      const second = await agent.call('revoke_mission', {
        mission_id: first.data.mission.mission_id,
      });
      expect([first.isError, second.isError]).toEqual([false, false]);

      const third = await agent.call<Refused>(
        'issue_mission',
        draftOn(github, ['github.read-code']),
      );
      expect(third.isError).toBe(true);
      expect(third.data.error).toMatchObject({ code: 'rate-limited', retry_after_seconds: 90 });
      expect(await rig.root.store.missions.listForCreator(rig.seeded.ada.id)).toHaveLength(1);
      // Reads are not mutations.
      expect((await agent.call('list_my_missions')).isError).toBe(false);
      expect(MANAGEMENT_MUTATIONS_PER_WINDOW).toBeGreaterThan(0);
      await agent.close();
    } finally {
      await rig.close();
    }
  });
});
