/**
 * `ManagementTools` on recorded ports: every act is performed **as the
 * delegating user**, the three mutations carry the delegation, and nothing is
 * decided here that the mission service did not decide. The behaviour against
 * the real services, authority and store is
 * `tests/integration/management/management-door.test.ts`.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { RiskId } from '@vaubaan/shared';
import { describe, expect, it } from 'vitest';

import { silentLogger } from '../logging';
import type { MissionDetail, MissionDraft, MissionOverview, MissionPreview } from '../missions';
import { explainOrphan } from '../missions/orphan-reason';
import { expandPreset, previewDraft } from '../missions/preview';
import { ACME_CATALOG, acmeConnection } from '../missions/testing';
import { enumerateCatalog } from '../missions/catalog-view';
import { MANAGEMENT_INSTRUCTIONS, MANAGEMENT_TOOLS } from './definitions';
import { toolResultOf } from './door';
import type { ManagementActor, ManagementCatalog, ManagementMissions } from './ports';
import {
  MANAGEMENT_MUTATION_WINDOW_MS,
  MANAGEMENT_MUTATIONS_PER_WINDOW,
  MANAGEMENT_REFUSAL_CODES,
  ManagementTools,
} from './tools';
import { catalogView, connectionView, missionView, previewView, uncoveredOfPreview } from './views';

const ACTOR: ManagementActor = {
  userId: 'user-ada',
  delegationId: 'delegation-1',
  clientId: 'vbn_client_agent',
};
const NOW = new Date('2026-10-13T09:00:00.000Z');
const SHARED: RiskId[] = ['acme.read', 'acme[staging].write'];

const DRAFT: MissionDraft = {
  name: 'Tidy the staging space',
  connections: [
    {
      connection_id: 'conn-acme',
      policy: [
        { risk_id: 'acme.read', quota: 10, rate_limit: { max: 5, window_seconds: 60 } },
        { risk_id: 'acme.admin', quota: 1, rate_limit: { max: 1, window_seconds: 60 } },
      ],
    },
  ],
  period: { kind: 'one-off' },
  expires_at: null,
};

interface Call {
  readonly method: string;
  readonly args: readonly unknown[];
}

function rig(
  options: {
    shared?: boolean;
    mutationsAllowed?: number;
    /** Replaces methods of the recorded mission port. */
    missions?: Partial<ManagementMissions>;
  } = {},
) {
  const calls: Call[] = [];
  const rateKeys: string[] = [];
  const connection = acmeConnection(
    options.shared ? { basis: 'share', authority: SHARED } : undefined,
  );
  const preview = (draft: MissionDraft): MissionPreview =>
    previewDraft({ connections: [connection], now: NOW }, draft);
  const record = <T>(method: string, args: readonly unknown[], value: T): Promise<T> => {
    calls.push({ method, args });
    return Promise.resolve(value);
  };
  const missions: ManagementMissions = {
    issuanceContext: (user) => record('issuanceContext', [user], [connection]),
    preview: (user, draft) => record('preview', [user, draft], preview(draft)),
    issue: (user, draft, issueOptions) =>
      record('issue', [user, draft, issueOptions], {
        ok: false,
        reason: 'refused',
        preview: preview(draft),
      } as const),
    rotate: (user, id, rotateOptions) =>
      record('rotate', [user, id, rotateOptions], { ok: false, reason: 'not-found' } as const),
    revoke: (user, id, revokeOptions) =>
      record('revoke', [user, id, revokeOptions], { ok: false, reason: 'not-found' } as const),
    list: (user) => record('list', [user], [] as MissionOverview[]),
    get: (user, id) => record('get', [user, id], null),
    ...options.missions,
  };
  const catalog: ManagementCatalog = {
    providers: () => ['acme'],
    get: (provider) =>
      provider === 'acme'
        ? {
            provider: 'acme',
            provider_label: 'Acme',
            derives_env: false,
            risks: enumerateCatalog(ACME_CATALOG),
            presets: ACME_CATALOG.presets ?? [],
          }
        : null,
  };
  let left = options.mutationsAllowed ?? Number.POSITIVE_INFINITY;
  const tools = new ManagementTools({
    missions,
    catalog,
    logger: silentLogger,
    rateLimit: {
      take: async (key, limit, windowMs) => {
        rateKeys.push(`${key}|${limit}|${windowMs}`);
        left -= 1;
        return left >= 0
          ? { allowed: true, remaining: 1, retryAfterMs: 0 }
          : { allowed: false, remaining: 0, retryAfterMs: 1_500 };
      },
    },
  });
  return { tools, calls, rateKeys, connection };
}

describe('ManagementTools — every act is the delegating user’s', () => {
  it('each tool calls the mission service with the user of the delegation, never another', async () => {
    const { tools, calls } = rig();
    await tools.listMyConnections(ACTOR);
    await tools.getCatalog(ACTOR, { provider: 'acme', connection_id: 'conn-acme' });
    await tools.listMyMissions(ACTOR);
    await tools.listMyMissions(ACTOR, { mission_id: 'm1' });
    await tools.previewPolicy(ACTOR, DRAFT);
    await tools.issueMission(ACTOR, DRAFT);
    await tools.rotateMissionToken(ACTOR, { mission_id: 'm1' });
    await tools.revokeMission(ACTOR, { mission_id: 'm1' });
    expect(calls.length).toBeGreaterThanOrEqual(8);
    for (const call of calls) {
      expect(call.args[0], call.method).toEqual({ id: ACTOR.userId });
    }
  });

  it('issue passes the delegation, so the mission records it and the audit names the client', async () => {
    const { tools, calls } = rig();
    const within: MissionDraft = {
      ...DRAFT,
      connections: [{ connection_id: 'conn-acme', preset: 'reader' }],
    };
    await tools.issueMission(ACTOR, within);
    const issue = calls.find((call) => call.method === 'issue');
    expect(issue?.args[2]).toEqual({
      delegation: { id: ACTOR.delegationId, clientId: ACTOR.clientId },
    });
  });

  it('a draft beyond the authority is refused before anything is issued, with the uncovered list', async () => {
    const { tools, calls, rateKeys } = rig({ shared: true });
    const outcome = await tools.issueMission(ACTOR, DRAFT);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal).toMatchObject({
      code: 'draft-refused',
      uncovered: [{ connection_id: 'conn-acme', provider: 'acme', risk_ids: ['acme.admin'] }],
    });
    expect(outcome.refusal.message).toContain('outside the user’s authority');
    expect(calls.some((call) => call.method === 'issue')).toBe(false);
    // The mutation budget is not spent on a draft that cannot be issued.
    expect(rateKeys).toEqual([]);
  });

  it('a draft refused for another reason says so, without an uncovered list', async () => {
    const { tools } = rig();
    const outcome = await tools.issueMission(ACTOR, { ...DRAFT, connections: [] });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal).toMatchObject({ code: 'draft-refused', uncovered: [] });
    expect(outcome.refusal.message).toContain('cannot be issued as written');
  });

  it('the mutations share one budget per delegation; reads and previews take none', async () => {
    const { tools, rateKeys } = rig({ mutationsAllowed: 1 });
    await tools.listMyConnections(ACTOR);
    await tools.previewPolicy(ACTOR, DRAFT);
    expect(rateKeys).toEqual([]);

    const within: MissionDraft = {
      ...DRAFT,
      connections: [{ connection_id: 'conn-acme', preset: 'reader' }],
    };
    await tools.issueMission(ACTOR, within);
    const second = await tools.issueMission(ACTOR, within);
    expect(rateKeys).toEqual(
      Array(2).fill(
        `delegation:${ACTOR.delegationId}:mutations|${MANAGEMENT_MUTATIONS_PER_WINDOW}|${MANAGEMENT_MUTATION_WINDOW_MS}`,
      ),
    );
    expect(second).toMatchObject({
      ok: false,
      refusal: { code: 'rate-limited', retry_after_seconds: 2 },
    });
  });

  it('a mission that is not the user’s is not found, whatever is asked of it', async () => {
    const { tools, calls } = rig();
    for (const outcome of [
      await tools.listMyMissions(ACTOR, { mission_id: 'm-of-bob' }),
      await tools.rotateMissionToken(ACTOR, { mission_id: 'm-of-bob' }),
      await tools.revokeMission(ACTOR, { mission_id: 'm-of-bob' }),
    ]) {
      expect(outcome).toMatchObject({
        ok: false,
        refusal: { code: 'mission-not-found', mission_id: 'm-of-bob' },
      });
    }
    expect(calls.some((call) => call.method === 'rotate' || call.method === 'revoke')).toBe(false);
  });

  describe('rotate reaches only the missions this delegation issued (docs/spec/vaubaan-gateway.md)', () => {
    /** An active mission of the user, as `get` returns it, issued by `delegationId` (or by the human). */
    const activeIssuedBy = (
      delegationId: string | null,
      clientId = ACTOR.clientId,
    ): MissionDetail =>
      ({
        mission: {
          id: 'm1',
          name: 'M',
          connections: [],
          policy: [],
          periodSeconds: null,
          delegationId,
        },
        state: { kind: 'active', period: { start: NOW.toISOString(), end: null }, remaining: {} },
        role: 'creator',
        creator: { id: 'user-ada', email: 'ada@example.com' },
        orphan: null,
        lost: [],
        token: null,
        issuedVia:
          delegationId === null
            ? null
            : { delegation_id: delegationId, client_id: clientId, client_name: 'Agent' },
        connections: [],
        policy: [],
      }) as unknown as MissionDetail;

    it.each([
      ['the user issued in the interface', null, ACTOR.clientId],
      ['another client of the user issued', 'delegation-of-another-client', 'vbn_client_other'],
      // The same program after a new consent is another delegation: the earlier one's
      // missions (possibly issued by whoever stole its tokens) are not its own.
      ['an earlier delegation of this same client issued', 'delegation-0', ACTOR.clientId],
    ])(
      'refuses a mission %s: nothing is rotated, no budget is spent',
      async (_n, delegationId, clientId) => {
        const { tools, calls, rateKeys } = rig({
          missions: { get: async () => activeIssuedBy(delegationId, clientId) },
        });
        const outcome = await tools.rotateMissionToken(ACTOR, { mission_id: 'm1' });
        expect(outcome).toMatchObject({
          ok: false,
          refusal: { code: 'mission-not-issued-here', mission_id: 'm1' },
        });
        expect(outcome.ok ? '' : outcome.refusal.hint).toMatch(/in the web interface/);
        expect(calls.some((call) => call.method === 'rotate')).toBe(false);
        expect(rateKeys).toEqual([]);
      },
    );

    it('rotates a mission this delegation issued, and tells the service which delegation asks', async () => {
      const { tools, calls } = rig({
        missions: { get: async () => activeIssuedBy(ACTOR.delegationId) },
      });
      await tools.rotateMissionToken(ACTOR, { mission_id: 'm1' });
      const rotate = calls.find((call) => call.method === 'rotate');
      expect(rotate?.args).toEqual([
        { id: ACTOR.userId },
        'm1',
        { delegation: { id: ACTOR.delegationId, clientId: ACTOR.clientId } },
      ]);
    });

    it('the service’s own refusal of a foreign mission reads the same (the two checks agree)', async () => {
      const { tools } = rig({
        missions: {
          get: async () => activeIssuedBy(ACTOR.delegationId),
          rotate: async () => ({ ok: false, reason: 'not-issued-by-delegation' }),
        },
      });
      expect(await tools.rotateMissionToken(ACTOR, { mission_id: 'm1' })).toMatchObject({
        ok: false,
        refusal: { code: 'mission-not-issued-here' },
      });
    });

    it('revoke still reaches every mission of the user: ending one enlarges nothing', async () => {
      const { tools, calls } = rig({ missions: { get: async () => activeIssuedBy(null) } });
      await tools.revokeMission(ACTOR, { mission_id: 'm1' });
      expect(calls.some((call) => call.method === 'revoke')).toBe(true);
    });

    it('a mission the user is only a member of is read, never changed: rotate and revoke answer not-found and reach no service', async () => {
      // Shared with the user by its creator: `get` returns it, with `role: 'member'`.
      const shared = (): MissionDetail => ({
        ...activeIssuedBy(ACTOR.delegationId),
        role: 'member',
        creator: { id: 'user-grace', email: 'grace@example.com' },
      });
      const { tools, calls } = rig({ missions: { get: async () => shared() } });
      for (const act of [
        () => tools.rotateMissionToken(ACTOR, { mission_id: 'm1' }),
        () => tools.revokeMission(ACTOR, { mission_id: 'm1' }),
      ]) {
        expect(await act()).toMatchObject({
          ok: false,
          refusal: { code: 'mission-not-found', mission_id: 'm1' },
        });
      }
      expect(calls.some((call) => call.method === 'rotate' || call.method === 'revoke')).toBe(
        false,
      );
      // It is listed, marked as such, with its creator.
      expect(missionView(shared(), ACTOR, (prefix) => prefix)).toMatchObject({
        role: 'member',
        creator_email: 'grace@example.com',
      });
      expect(missionView(activeIssuedBy(null), ACTOR, (prefix) => prefix)).toMatchObject({
        role: 'creator',
        creator_email: 'ada@example.com',
      });
    });

    it('a listing says which missions this delegation issued', () => {
      const view = (delegationId: string | null) =>
        missionView(activeIssuedBy(delegationId), ACTOR, (prefix) => prefix).issued_via;
      expect(view(null)).toBeNull();
      expect(view(ACTOR.delegationId)).toMatchObject({ this_client: true, this_delegation: true });
      expect(view('delegation-0')).toMatchObject({ this_client: true, this_delegation: false });
    });
  });

  describe('the mission service decides last: its answer after the door’s own check stands', () => {
    const within: MissionDraft = {
      ...DRAFT,
      connections: [{ connection_id: 'conn-acme', preset: 'reader' }],
    };
    /** A mission of the user that serves calls, as `get` returns it. */
    const active = {
      mission: {
        id: 'm1',
        name: 'M',
        connections: [],
        policy: [],
        periodSeconds: null,
        delegationId: ACTOR.delegationId,
      },
      state: { kind: 'active', period: { start: NOW.toISOString(), end: null }, remaining: {} },
      role: 'creator',
      creator: { id: 'user-ada', email: 'ada@example.com' },
      orphan: null,
      token: null,
      issuedVia: {
        delegation_id: ACTOR.delegationId,
        client_id: ACTOR.clientId,
        client_name: 'Agent',
      },
      connections: [],
      policy: [],
    } as unknown as MissionDetail;

    it('issue refuses a draft the preview accepted (the authority changed in between): draft-refused, with the service’s preview', async () => {
      // The recorded `issue` answers `refused`, although `preview` said the draft passes.
      const { tools, calls, rateKeys } = rig();
      const outcome = await tools.issueMission(ACTOR, within);
      expect(calls.map((call) => call.method)).toEqual(['preview', 'issue']);
      expect(outcome).toMatchObject({
        ok: false,
        refusal: { code: 'draft-refused', uncovered: [], preview: { name: within.name } },
      });
      // The act was attempted: it counts against the mutation budget.
      expect(rateKeys).toHaveLength(1);
    });

    it('an issuance outcome the door does not know is a failure, not an answer made up here', async () => {
      const { tools } = rig({
        missions: { issue: async () => ({ ok: false, reason: 'not-found' }) },
      });
      await expect(tools.issueMission(ACTOR, within)).rejects.toThrow(
        /unexpected issuance outcome "not-found"/,
      );
    });

    it('rotate answers not-found or inactive for a mission `get` saw active: the refusal is the service’s', async () => {
      const gone = rig({
        missions: {
          get: async () => active,
          rotate: async () => ({ ok: false, reason: 'not-found' }),
        },
      });
      expect(await gone.tools.rotateMissionToken(ACTOR, { mission_id: 'm1' })).toMatchObject({
        ok: false,
        refusal: { code: 'mission-not-found', mission_id: 'm1' },
      });

      const revokedMeanwhile = rig({
        missions: {
          get: async () => active,
          rotate: async () => ({ ok: false, reason: 'inactive', state: 'revoked' }),
        },
      });
      const outcome = await revokedMeanwhile.tools.rotateMissionToken(ACTOR, { mission_id: 'm1' });
      expect(outcome).toMatchObject({
        ok: false,
        refusal: { code: 'mission-inactive', mission_id: 'm1', state: 'revoked' },
      });
      if (!outcome.ok) expect(outcome.refusal).not.toHaveProperty('orphan');
      // Both attempts reached the service: both spent the budget.
      expect(gone.rateKeys).toHaveLength(1);
      expect(revokedMeanwhile.rateKeys).toHaveLength(1);
    });

    it('revoke answers not-found for a mission `get` saw: mission-not-found', async () => {
      const { tools } = rig({ missions: { get: async () => active } });
      expect(await tools.revokeMission(ACTOR, { mission_id: 'm1' })).toMatchObject({
        ok: false,
        refusal: { code: 'mission-not-found' },
      });
    });
  });

  it('every refusal code is in the handbook’s table, and the table names no other', () => {
    const handbook = readFileSync(
      resolve(
        dirname(fileURLToPath(import.meta.url)),
        '../../../../../docs/handbook/management-door.md',
      ),
      'utf8',
    );
    const table = handbook.slice(handbook.indexOf('| `error.code`'));
    const documented = [...table.slice(0, table.indexOf('\n\n')).matchAll(/^\| `([a-z-]+)`/gm)]
      .map((match) => match[1])
      .filter((code) => code !== 'error.code');
    // `internal-error` is the door's own (a method that threw), not a tool's refusal.
    expect(documented.sort()).toEqual([...MANAGEMENT_REFUSAL_CODES, 'internal-error'].sort());
  });

  it('get_catalog names the providers when asked for one that does not exist', async () => {
    const { tools } = rig();
    expect(await tools.getCatalog(ACTOR, { provider: 'nope' })).toMatchObject({
      ok: false,
      refusal: { code: 'unknown-provider', providers: ['acme'] },
    });
    expect(await tools.getCatalog(ACTOR, { provider: 'acme', connection_id: 'x' })).toMatchObject({
      ok: false,
      refusal: { code: 'unknown-connection' },
    });
  });
});

describe('views', () => {
  it('a connection shows its exact restriction and which env-qualified ids are usable', () => {
    const owner = connectionView(acmeConnection());
    expect(owner.authority).toMatchObject({ basis: 'owner', whole_catalog: true });
    expect(owner.env_qualified_risks).toEqual({
      derives_env: false,
      default_env: null,
      labelled_envs: ['staging', 'prod'],
      unlabelled_resources: ['scratch'],
      usable_risk_ids: ['acme[staging].write', 'acme[prod].write', 'acme[staging].bulk-delete'],
      unusable_risk_ids: [],
    });
    expect(owner.presets.every((preset) => preset.within_authority)).toBe(true);

    const shared = connectionView(acmeConnection({ basis: 'share', authority: SHARED }));
    expect(shared.authority).toEqual({ basis: 'share', risk_ids: SHARED, whole_catalog: false });
    const presets = Object.fromEntries(shared.presets.map((preset) => [preset.id, preset]));
    expect(presets.reader?.within_authority).toBe(true);
    expect(presets.developer?.outside_authority).toEqual(['acme[staging].bulk-delete']);
    // `writer` names the base id `acme.write`: held in one environment, it is covered.
    expect(presets.writer?.within_authority).toBe(true);
  });

  it('a preset is judged with the mission module’s own expansion, on what the user holds', () => {
    // Nothing of `acme.write` is held: the base id expands to nothing and is outside.
    const readOnly = connectionView(acmeConnection({ basis: 'share', authority: ['acme.read'] }));
    const presets = Object.fromEntries(readOnly.presets.map((preset) => [preset.id, preset]));
    expect(presets.reader).toMatchObject({ within_authority: true, outside_authority: [] });
    expect(presets.writer).toMatchObject({
      within_authority: false,
      outside_authority: ['acme.write'],
    });
    expect(presets.developer?.outside_authority).toEqual([
      'acme[staging].write',
      'acme[staging].bulk-delete',
    ]);

    // The same answer as `expandPreset` over the held part of the catalog, for every preset.
    for (const authority of [SHARED, ['acme.read'], ['acme[prod].write'], []] as RiskId[][]) {
      const connection = acmeConnection({ basis: 'share', authority });
      const held = new Set(authority);
      for (const [index, preset] of connection.presets.entries()) {
        const { lines } = expandPreset(
          preset,
          { risks: connection.risks.filter((r) => held.has(r.risk_id)), derives_env: true },
          [],
        );
        expect(connectionView(connection).presets[index]?.outside_authority).toEqual(
          lines.map((line) => line.risk_id).filter((id) => !held.has(id)),
        );
      }
    }
  });

  it('env usability is `isResolvable` on the resources a mission can select: a stale label does not count', () => {
    const onlyStaleProd = acmeConnection({
      resources: [
        {
          id: 'r1',
          ref: 'app-staging',
          display_name: 'App (staging)',
          env: 'staging',
          hidden: false,
          stale: false,
          self: false,
        },
        {
          id: 'r2',
          ref: 'app-prod',
          display_name: 'App (prod)',
          env: 'prod',
          hidden: false,
          stale: true,
          self: false,
        },
      ],
    });
    const view = connectionView(onlyStaleProd).env_qualified_risks;
    expect(view.labelled_envs).toEqual(['staging']);
    expect(view.usable_risk_ids).toEqual(['acme[staging].write', 'acme[staging].bulk-delete']);
    expect(view.unusable_risk_ids).toEqual(['acme[prod].write']);
  });

  it('whether an orphaned mission can come back is the mission module’s answer, for every cause', () => {
    const overview = (cause: string): MissionOverview =>
      ({
        mission: {
          id: 'm1',
          name: 'M',
          periodSeconds: null,
          expiresAt: null,
          createdAt: NOW.toISOString(),
          connections: [],
          policy: [],
        },
        role: 'creator',
        creator: { id: 'user-ada', email: 'ada@example.com' },
        state: { kind: 'orphaned' },
        orphan: { cause, connection_id: 'conn-acme', uncovered: ['acme.read'] },
        lost: [],
        token: null,
        issuedVia: null,
      }) as unknown as MissionOverview;
    const causes = [
      'creator-removed',
      'connection-missing',
      'connection-revoked',
      'authority-lost',
    ] as const;
    const answers = causes.map((cause) => {
      const view = missionView(overview(cause), ACTOR, (prefix) => prefix);
      const orphan = { cause, connection_id: 'conn-acme', uncovered: ['acme.read' as RiskId] };
      expect(view.orphan?.can_come_back, cause).toBe(explainOrphan(orphan, []).reversible);
      return view.orphan?.can_come_back;
    });
    expect(answers).toEqual([true, false, false, true]);
  });

  it('with no labelled resource, env-qualified ids are unusable unless the provider derives the environment', () => {
    const unlabelled = acmeConnection({
      resources: [
        {
          id: 'r',
          ref: 'scratch',
          display_name: 'Scratch',
          env: null,
          hidden: false,
          stale: false,
          self: false,
        },
      ],
    });
    const view = connectionView(unlabelled).env_qualified_risks;
    expect(view.usable_risk_ids).toEqual([]);
    expect(view.unusable_risk_ids).toEqual([
      'acme[staging].write',
      'acme[prod].write',
      'acme[staging].bulk-delete',
    ]);
    const derived = connectionView({ ...unlabelled, derives_env: true }).env_qualified_risks;
    expect(derived.unusable_risk_ids).toEqual([]);
  });

  it('stale resources are not offered; hidden ones are, flagged', () => {
    const view = connectionView(
      acmeConnection({
        resources: [
          {
            id: 'a',
            ref: 'gone',
            display_name: 'Gone',
            env: 'prod',
            hidden: false,
            stale: true,
            self: false,
          },
          {
            id: 'b',
            ref: 'archive',
            display_name: 'Archive',
            env: null,
            hidden: true,
            stale: false,
            self: false,
          },
        ],
      }),
    );
    expect(view.resources).toEqual([
      { ref: 'archive', display_name: 'Archive', env: null, hidden: true },
    ]);
    expect(view.env_qualified_risks.labelled_envs).toEqual([]);
  });

  it("the instance's own resource is never offered, nor does its label count", () => {
    const view = connectionView(
      acmeConnection({
        resources: [
          {
            id: 'h',
            ref: 'gateway-host',
            display_name: 'Gateway host',
            env: 'prod',
            hidden: false,
            stale: false,
            self: true,
          },
        ],
      }),
    );
    expect(view.resources).toEqual([]);
    expect(view.env_qualified_risks.labelled_envs).toEqual([]);
  });

  it('the catalog is explicit ids; a connection flags each one', () => {
    const { tools: _tools, connection } = rig({ shared: true });
    const catalog = {
      provider: 'acme',
      provider_label: 'Acme',
      derives_env: false,
      risks: enumerateCatalog(ACME_CATALOG),
      presets: ACME_CATALOG.presets ?? [],
    };
    const plain = catalogView(catalog, null);
    expect(plain.risks.map((risk) => risk.risk_id)).toContain('acme[prod].write');
    expect(plain.risks.every((risk) => !('in_my_authority' in risk))).toBe(true);
    const flagged = catalogView(catalog, connection);
    expect(
      flagged.risks.filter((risk) => risk.in_my_authority).map((risk) => risk.risk_id),
    ).toEqual(SHARED);
  });

  it('the built-in `everything-i-hold` is listed last, within the authority, counted on the resources known now', () => {
    const shared = acmeConnection({ basis: 'share', authority: SHARED });
    const listed = connectionView(shared).presets.at(-1);
    expect(listed).toMatchObject({
      id: 'everything-i-hold',
      label: 'Everything I hold on this account',
      within_authority: true,
      outside_authority: [],
      built_in: true,
      risks: 2,
    });
    expect(connectionView(shared).presets.filter((p) => p.built_in)).toHaveLength(1);
    // An owner holds the whole catalog: every non-deprecated id, the fallback included.
    expect(connectionView(acmeConnection()).presets.at(-1)?.risks).toBe(6);

    const catalog = {
      provider: 'acme',
      provider_label: 'Acme',
      derives_env: false,
      risks: enumerateCatalog(ACME_CATALOG),
      presets: ACME_CATALOG.presets ?? [],
    };
    // Without a connection there is nothing to write out: it is not listed.
    expect(catalogView(catalog, null).presets.map((p) => p.id)).not.toContain('everything-i-hold');
    const written = catalogView(catalog, shared).presets.at(-1);
    expect(written).toMatchObject({ id: 'everything-i-hold', built_in: true, risks: 2 });
    expect(written?.entries.map((e) => e.risk_id)).toEqual(SHARED);
  });

  it('preview and issue accept `everything-i-hold` as a preset id: the policy is the explicit list', () => {
    const draft: MissionDraft = {
      ...DRAFT,
      connections: [{ connection_id: 'conn-acme', preset: 'everything-i-hold' }],
    };
    const preview = previewDraft(
      { connections: [acmeConnection({ basis: 'share', authority: SHARED })], now: NOW },
      draft,
    );
    const view = previewView(preview);
    expect(view.ok).toBe(true);
    expect(view.policy.map((line) => line.risk_id)).toEqual(SHARED);
    expect(view.connections[0]?.preset).toEqual({
      id: 'everything-i-hold',
      label: 'Everything I hold on this account',
    });
    expect(view.notices.map((n) => n.code)).toContain('everything-i-hold-expanded');
  });

  it('a preview carries the uncovered list per connection', () => {
    const preview = previewDraft(
      { connections: [acmeConnection({ basis: 'share', authority: SHARED })], now: NOW },
      DRAFT,
    );
    expect(uncoveredOfPreview(preview)).toEqual([
      { connection_id: 'conn-acme', provider: 'acme', risk_ids: ['acme.admin'] },
    ]);
    expect(previewView(preview)).toMatchObject({ ok: false, name: DRAFT.name });
  });

  it('a mission view never carries more of the token than its masked prefix', () => {
    const overview = {
      mission: {
        id: 'm1',
        name: 'M',
        creatorUserId: 'user-ada',
        status: 'orphaned',
        periodAnchor: NOW.toISOString(),
        periodSeconds: 3600,
        expiresAt: null,
        delegationId: 'delegation-1',
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
        closedAt: null,
        connections: [{ connectionId: 'conn-acme', resourceScope: 'all', resourceIds: [] }],
        policy: [
          { riskId: 'acme.read', quota: 5, rateLimit: 2, rateWindowSeconds: 60, gate: 'approval' },
        ],
      },
      role: 'creator',
      creator: { id: 'user-ada', email: 'ada@example.com' },
      state: { kind: 'orphaned' },
      orphan: { cause: 'connection-revoked', connection_id: 'conn-acme', uncovered: [] },
      lost: [{ connection_id: 'conn-acme', cause: 'connection-revoked', final: true }],
      token: { prefix: 'AbCd1234', createdAt: NOW.toISOString() },
      issuedVia: { delegation_id: 'delegation-2', client_id: 'other', client_name: 'Other agent' },
    } as MissionOverview;
    const view = missionView(overview, ACTOR, (prefix) => `masked:${prefix}`);
    expect(view).toMatchObject({
      mission_id: 'm1',
      state: 'orphaned',
      orphan: { cause: 'connection-revoked', can_come_back: false },
      lost_connections: [{ connection_id: 'conn-acme', cause: 'connection-revoked', final: true }],
      period: { kind: 'recurring', length_seconds: 3600 },
      session: null,
      issued_via: {
        client_id: 'other',
        client_name: 'Other agent',
        this_client: false,
        this_delegation: false,
      },
      token_prefix: 'masked:AbCd1234',
      policy: [
        {
          risk_id: 'acme.read',
          quota: 5,
          rate_limit: { max: 2, window_seconds: 60 },
          gate: 'approval',
          remaining: null,
        },
      ],
      exhausted: [],
    });
  });
});

describe('tool definitions and results', () => {
  it('every description states what the tool is for; the policy tools state the rules of issuance', () => {
    const text = Object.fromEntries(MANAGEMENT_TOOLS.map((tool) => [tool.name, tool.description]));
    expect(text.list_my_connections).toContain('exact list of RiskIds');
    expect(text.list_my_connections).toContain('unlabelled resources refuse it');
    expect(text.get_catalog).toContain('explicit RiskIds');
    expect(text.get_catalog).toContain('preset');
    expect(text.preview_policy).toContain('explicit RiskIds only');
    expect(text.preview_policy).toContain('one connection per provider');
    expect(text.preview_policy).toContain('a quota and a rate limit for every risk');
    expect(text.preview_policy).toContain('labelled with that environment');
    // `all` and `connection` are told apart where a draft is composed.
    expect(text.preview_policy).toContain("`{ scope: 'connection' }` — the whole connection");
    expect(text.preview_policy).toContain('a resource discovered later is not reached');
    expect(text.issue_mission).toContain("`resources: { scope: 'connection' }`");
    expect(text.list_my_missions).toContain('`resource_scopes`');
    expect(MANAGEMENT_INSTRUCTIONS).toContain("`{ scope: 'connection' }` is the whole connection");
    expect(text.issue_mission).toContain('The creator is the user, not you');
    expect(text.issue_mission).toContain('shown this once');
    expect(text.issue_mission).toContain('they alone answer the requests');
    expect(text.rotate_mission_token).toContain('orphaned mission is not rotated');
    expect(text.revoke_mission).toContain('orphaned mission can be revoked');
    for (const tool of MANAGEMENT_TOOLS) {
      expect(tool.description.length, tool.name).toBeLessThan(1200);
    }
  });

  it('the draft tools refuse an unknown key and a non-draft at the schema', () => {
    const preview = MANAGEMENT_TOOLS.find((tool) => tool.name === 'preview_policy');
    expect(preview?.inputSchema.safeParse(DRAFT).success).toBe(true);
    expect(preview?.inputSchema.safeParse({ ...DRAFT, accepted_risks: ['*'] }).success).toBe(false);
    expect(preview?.inputSchema.safeParse({ name: 'x' }).success).toBe(false);
    const whole = (resources: unknown) => ({
      ...DRAFT,
      connections: [{ ...DRAFT.connections[0], resources }],
    });
    expect(preview?.inputSchema.safeParse(whole({ scope: 'connection' })).success).toBe(true);
    expect(
      preview?.inputSchema.safeParse(whole({ scope: 'connection', resource_ids: ['r1'] })).success,
    ).toBe(false);
    expect(preview?.inputSchema.safeParse(whole({ scope: 'everything' })).success).toBe(false);
    const revoke = MANAGEMENT_TOOLS.find((tool) => tool.name === 'revoke_mission');
    expect(revoke?.inputSchema.safeParse({ mission_id: 'm1' }).success).toBe(true);
    expect(revoke?.inputSchema.safeParse({ mission_id: 'm1', force: true }).success).toBe(false);
    expect(revoke?.inputSchema.safeParse({}).success).toBe(false);
  });

  it('an answer is structured content, also serialized as text; a refusal is a tool error with its code', () => {
    const ok = toolResultOf({ ok: true, data: { connections: [] } });
    expect(ok).toEqual({
      content: [{ type: 'text', text: JSON.stringify({ connections: [] }, null, 2) }],
      structuredContent: { connections: [] },
    });
    const refusal = {
      code: 'mission-not-found',
      message: 'No mission.',
      hint: 'List them.',
    } as const;
    const no = toolResultOf({ ok: false, refusal });
    expect(no.isError).toBe(true);
    expect(no.structuredContent).toEqual({ error: refusal });
    expect((no.content[0] as { text: string }).text).toMatch(
      /^mission-not-found: No mission\. List them\./,
    );
  });
});
