/**
 * Every real answer of every management tool matches the output schema the
 * tool advertises (spec §4.1 bis; handbook management-door "Output schemas").
 *
 * Why this test exists: the MCP SDK validates a successful answer against the
 * advertised schema **after the tool ran**, and replaces one that does not
 * match by a bare error. For `issue_mission` and `rotate_mission_token` that
 * would lose a token shown once. So each success path of each tool is driven
 * here through the real door — real composition root, `:memory:` store, the
 * official MCP client holding a delegated token — and its answer is checked
 * three times: the server's SDK let it through (the answer arrived), the
 * official client validated it against the JSON Schema of `tools/list` (it
 * does once the tools were listed), and the Zod schema parses it.
 *
 * A refusal is a tool error and is not validated by either side: the last
 * block holds that its `{ error }` content still arrives whole.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  MANAGEMENT_OUTPUT_SCHEMAS,
  MANAGEMENT_TOOL_NAMES,
  type IssuedMissionAnswer,
  type ManagementRefusal,
  type ManagementToolName,
  type MissionsAnswer,
  type RotatedTokenAnswer,
} from '../../../src/server/management';
import { ADA, BOB, draftOn, openManagementRig, type Agent, type ManagementRig } from './support';

const SHARED = ['github.read-code', 'github.read-meta', 'github.create-pr'] as const;

describe('management door — every answer matches its advertised output schema', () => {
  let rig: ManagementRig;
  let github: string;
  let supabase: string;
  /** Which tools answered "yes" at least once in a test: none may be left out. */
  const answered = new Set<ManagementToolName>();

  beforeEach(async () => {
    rig = await openManagementRig();
    github = rig.seeded.github.connection.id;
    supabase = rig.seeded.supabase.connection.id;
  });
  afterEach(() => rig.close());

  /** An agent whose client has listed the tools, hence validates answers against their schemas. */
  async function agentOf(claims: Record<string, unknown> = ADA): Promise<Agent> {
    const agent = await rig.agentOf(claims);
    await agent.client.listTools();
    return agent;
  }

  /**
   * Calls a tool on a success path and holds its answer to the schema. The
   * top-level keys of the answer must all be named by the schema: the schema
   * describes the answer, it does not merely tolerate it.
   */
  async function yes<T>(
    agent: Agent,
    name: ManagementToolName,
    args: Record<string, unknown> = {},
  ): Promise<T> {
    const answer = await agent.call<Record<string, unknown>>(name, args);
    expect(answer.protocolError, `${name}: ${answer.text}`).toBe(false);
    expect(answer.isError, `${name}: ${answer.text}`).toBe(false);
    const schema = MANAGEMENT_OUTPUT_SCHEMAS[name];
    const parsed = schema.safeParse(answer.data);
    expect(parsed.success, `${name}: ${parsed.success ? '' : z.prettifyError(parsed.error)}`).toBe(
      true,
    );
    expect(Object.keys(schema.shape)).toEqual(expect.arrayContaining(Object.keys(answer.data)));
    // The text form is the same answer, for clients that only read text.
    expect(JSON.parse(answer.text)).toEqual(answer.data);
    answered.add(name);
    return answer.data as T;
  }

  async function shareWithBob(): Promise<void> {
    await rig.root.shares.service.share(await rig.actor(rig.seeded.ada), github, {
      target: { kind: 'user', email: rig.seeded.bob.email },
      riskIds: SHARED,
    });
  }

  it('tools/list advertises an object output schema for each of the seven tools', async () => {
    const agent = await rig.agentOf(ADA);
    const { tools } = await agent.client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([...MANAGEMENT_TOOL_NAMES]);
    for (const tool of tools) {
      const name = tool.name as ManagementToolName;
      expect(tool.outputSchema, name).toMatchObject({ type: 'object' });
      // What is advertised is the Zod schema's JSON Schema, key for key.
      const expected = z.toJSONSchema(MANAGEMENT_OUTPUT_SCHEMAS[name], { io: 'output' });
      expect(Object.keys(tool.outputSchema?.properties ?? {}), name).toEqual(
        Object.keys(expected.properties ?? {}),
      );
      expect(tool.outputSchema?.required, name).toEqual(expected.required);
    }
    await agent.close();
  });

  it('list_my_connections: an owner, with and without the retired `include_experimental`; a beneficiary; somebody who holds nothing', async () => {
    const ada = await agentOf(ADA);
    await yes(ada, 'list_my_connections');
    await yes(ada, 'list_my_connections', { include_experimental: true });
    await ada.close();

    const nobody = await agentOf(BOB);
    await yes(nobody, 'list_my_connections');
    await shareWithBob();
    await yes(nobody, 'list_my_connections');
    await nobody.close();
  });

  it('get_catalog: every provider of the instance, alone and against a connection', async () => {
    const agent = await agentOf(ADA);
    const { connections } = await yes<{
      connections: { connection_id: string; provider: string }[];
    }>(agent, 'list_my_connections');
    expect(connections.length).toBeGreaterThanOrEqual(4);
    for (const connection of connections) {
      await yes(agent, 'get_catalog', { provider: connection.provider });
      await yes(agent, 'get_catalog', {
        provider: connection.provider,
        connection_id: connection.connection_id,
      });
    }
    await agent.close();
  });

  it('preview_policy: a draft that passes, one beyond the authority, a preset alone, an unresolvable environment, an unknown risk', async () => {
    await shareWithBob();
    const bob = await agentOf(BOB);
    await yes(bob, 'preview_policy', draftOn(github, ['github.read-code']));
    // Beyond the authority: an answer with `ok: false`, issues and the uncovered list.
    const beyond = await yes<{ ok: boolean }>(
      bob,
      'preview_policy',
      draftOn(github, ['github.read-code', 'github.feature-branch-write']),
    );
    expect(beyond.ok).toBe(false);
    // A preset bounded by the authority: entries skipped.
    await yes(bob, 'preview_policy', {
      name: 'From a preset',
      connections: [{ connection_id: github, preset: 'developer' }],
      period: { kind: 'one-off' },
      expires_at: '2027-01-01T00:00:00.000Z',
    });
    await bob.close();

    const ada = await agentOf(ADA);
    // No resource of the connection is labelled `preview`.
    await yes(ada, 'preview_policy', draftOn(supabase, ['supabase[preview].row-write-one']));
    await yes(ada, 'preview_policy', draftOn(supabase, ['supabase[staging].row-write-one']));
    await yes(ada, 'preview_policy', draftOn(github, ['github.no-such-risk']));
    await yes(ada, 'preview_policy', {
      name: 'Two providers',
      connections: [
        { connection_id: github, preset: 'read-only' },
        { provider: 'supabase', preset: 'read-only', resources: { scope: 'all' } },
      ],
      period: { kind: 'recurring', length_seconds: 3600 },
      expires_at: null,
    });
    // The whole connection: a notice about labels of later resources rides along.
    await yes(ada, 'preview_policy', {
      name: 'The whole account',
      connections: [
        { connection_id: supabase, preset: 'read-only', resources: { scope: 'connection' } },
      ],
      period: { kind: 'one-off' },
      expires_at: null,
    });
    await ada.close();
  });

  it('issue_mission, list_my_missions, rotate_mission_token, revoke_mission: the token arrives, every state reads', async () => {
    await shareWithBob();
    const agent = await agentOf(BOB);

    // ── issue: explicit policy, and a preset with an expiry ──
    const issued = await yes<IssuedMissionAnswer>(
      agent,
      'issue_mission',
      draftOn(github, ['github.read-code', 'github.create-pr']),
    );
    expect(issued.token.secret).toMatch(/^vbn_live_/);
    expect(issued.bootstrap_kit.env).toContain(issued.token.secret);
    const fromPreset = await yes<IssuedMissionAnswer>(agent, 'issue_mission', {
      name: 'One-off from a preset',
      connections: [{ connection_id: github, preset: 'read-only' }],
      period: { kind: 'one-off' },
      expires_at: '2027-01-01T00:00:00.000Z',
    });
    expect(fromPreset.token.secret).toMatch(/^vbn_live_/);

    // ── read: the list, one mission in detail ──
    const listed = await yes<MissionsAnswer>(agent, 'list_my_missions');
    expect(listed.missions).toHaveLength(2);
    await yes(agent, 'list_my_missions', { mission_id: issued.mission.mission_id });
    await yes(agent, 'list_my_missions', { mission_id: fromPreset.mission.mission_id });

    // ── rotate: the new token arrives ──
    const rotated = await yes<RotatedTokenAnswer>(agent, 'rotate_mission_token', {
      mission_id: issued.mission.mission_id,
    });
    expect(rotated.token.secret).toMatch(/^vbn_live_/);
    expect(rotated.token.secret).not.toBe(issued.token.secret);

    // ── an orphaned mission: `orphan` is set, in the list and in detail ──
    const [share] = await rig.root.store.shares.listForConnection(github);
    await rig.root.shares.service.revoke(await rig.actor(rig.seeded.ada), share?.id ?? '');
    const orphaned = await yes<MissionsAnswer>(agent, 'list_my_missions');
    expect(orphaned.missions.map((m) => m.state)).toEqual(['orphaned', 'orphaned']);
    expect(orphaned.missions[0]?.orphan).not.toBeNull();
    await yes(agent, 'list_my_missions', { mission_id: issued.mission.mission_id });

    // ── revoke: the first time, and again ──
    await yes(agent, 'revoke_mission', { mission_id: issued.mission.mission_id });
    await yes(agent, 'revoke_mission', { mission_id: issued.mission.mission_id });
    const open = await yes<MissionsAnswer>(agent, 'list_my_missions');
    expect(open.hidden_closed).toBe(1);
    const all = await yes<MissionsAnswer>(agent, 'list_my_missions', { include_closed: true });
    expect(all.missions.map((m) => m.state).sort()).toEqual(['orphaned', 'revoked']);
    await yes(agent, 'list_my_missions', { mission_id: issued.mission.mission_id });
    await agent.close();
  });

  it('an expired mission reads through the schema too', async () => {
    const agent = await agentOf(ADA);
    const soon = new Date(Date.now() + 3_600_000).toISOString();
    const issued = await yes<IssuedMissionAnswer>(agent, 'issue_mission', {
      ...draftOn(github, ['github.read-code']),
      expires_at: soon,
    });
    rig.root.store.db
      .prepare('UPDATE missions SET expires_at = ? WHERE id = ?')
      .run('2020-01-01T00:00:00.000Z', issued.mission.mission_id);
    const closed = await yes<MissionsAnswer>(agent, 'list_my_missions', { include_closed: true });
    expect(closed.missions.map((m) => m.state)).toEqual(['expired']);
    await yes(agent, 'list_my_missions', { mission_id: issued.mission.mission_id });
    await agent.close();
  });

  it('covered every tool', () => {
    // Runs last in the file: each tool answered "yes" through `yes()` above.
    expect([...answered].sort()).toEqual([...MANAGEMENT_TOOL_NAMES].sort());
  });

  describe('a refusal is unaffected by the output schema', () => {
    type Refused = { readonly error: ManagementRefusal };

    it('a tool error keeps its `{ error }` content, whole, although the tool advertises a schema', async () => {
      await shareWithBob();
      const agent = await agentOf(BOB);

      const beyond = await agent.call<Refused>(
        'issue_mission',
        draftOn(github, ['github.read-code', 'github.feature-branch-write']),
      );
      expect(beyond).toMatchObject({ isError: true, protocolError: false });
      expect(beyond.data.error).toMatchObject({
        code: 'draft-refused',
        uncovered: [{ connection_id: github, risk_ids: ['github.feature-branch-write'] }],
      });
      expect(beyond.data.error.preview).toMatchObject({ ok: false });
      expect(beyond.text).toMatch(/^draft-refused: /);

      for (const [name, args, code] of [
        ['list_my_missions', { mission_id: 'nope' }, 'mission-not-found'],
        ['rotate_mission_token', { mission_id: 'nope' }, 'mission-not-found'],
        ['revoke_mission', { mission_id: 'nope' }, 'mission-not-found'],
        ['get_catalog', { provider: 'nope' }, 'unknown-provider'],
        ['get_catalog', { provider: 'github', connection_id: 'nope' }, 'unknown-connection'],
      ] as const) {
        const refused = await agent.call<Refused>(name, args);
        expect(refused, name).toMatchObject({ isError: true, protocolError: false });
        expect(refused.data.error, name).toMatchObject({ code });
        expect(typeof refused.data.error.hint, name).toBe('string');
      }

      // `mission-inactive`, with the state and the orphan reason it carries.
      const issued = await agent.call<IssuedMissionAnswer>(
        'issue_mission',
        draftOn(github, ['github.read-code']),
      );
      await agent.call('revoke_mission', { mission_id: issued.data.mission.mission_id });
      const inactive = await agent.call<Refused>('rotate_mission_token', {
        mission_id: issued.data.mission.mission_id,
      });
      expect(inactive.isError).toBe(true);
      expect(inactive.data.error).toMatchObject({ code: 'mission-inactive', state: 'revoked' });
      await agent.close();
    });

    it('arguments that fail the input schema are still a tool error with the validation message', async () => {
      const agent = await agentOf(ADA);
      const invalid = await agent.call('revoke_mission', { mission_id: 'x', force: true });
      expect(invalid.isError).toBe(true);
      expect(invalid.text).toMatch(/Input validation error|Invalid arguments/);
      await agent.close();
    });
  });
});
