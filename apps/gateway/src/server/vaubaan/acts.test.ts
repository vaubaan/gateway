/**
 * `VaubaanActs` and the ports on recorded mission services: every act is
 * performed **as the calling mission's creator**, the five mutations carry the
 * calling mission, the self rule holds whatever the mission service would
 * allow, and nothing is decided here that the mission service did not decide.
 * The behaviour against the real services, authority and store, through the
 * execution door, is `tests/integration/vaubaan/vaubaan-plugin.test.ts`.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { RiskId } from '@vaubaan/shared';
import { describe, expect, it } from 'vitest';

import { silentLogger } from '../logging';
import type {
  MissionChanges,
  MissionDetail,
  MissionDraft,
  MissionEditView,
  MissionOverview,
  MissionPreview,
} from '../missions';
import { explainOrphan } from '../missions/orphan-reason';
import { macroActionsOf } from '../../lib/missions/macro-actions';
import { previewDraft } from '../../lib/missions/preview';
import { ACME_CATALOG, ACME_RESOURCES, acmeAccount } from '../../../tests/support/missions/testing';
import { enumerateCatalog } from '../../lib/missions/catalog-view';
import { toolResultOf, vaubaanTools, type VaubaanCaller } from '@vaubaan/plugin-vaubaan';
import { VAUBAAN_REFUSAL_CODES, VaubaanActs } from './acts';
import { createVaubaanPorts } from './index';
import { toolSchemasDocument, VAUBAAN_INPUTS } from './inputs';
import type { VaubaanCatalog, VaubaanMissions, VaubaanPlugins } from './ports';
import { catalogView, accountView, missionView, previewView, uncoveredOfPreview } from './views';

/** The calling mission, Ada's, called with her own key. */
const ACTOR: VaubaanCaller = {
  missionId: 'mission-caller',
  userId: 'user-ada',
  holderUserId: 'user-ada',
};
const NOW = new Date('2026-10-13T09:00:00.000Z');
const SHARED: RiskId[] = ['acme.read', 'acme[staging].write'];

const DRAFT: MissionDraft = {
  name: 'Tidy the staging space',
  accounts: [
    {
      account_id: 'conn-acme',
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

/** A plugins port whose caller is never an administrator: the mission acts never reach it. */
const NO_PLUGINS: VaubaanPlugins = {
  isAdministrator: async () => false,
  upload: async () => ({ ok: false, code: 'never', message: 'never' }),
  activationUrl: (digest) => `https://gateway.example.com/admin/plugins#version-${digest}`,
  status: async () => ({ plugins: [], installed: [] }),
};

function rig(
  options: {
    shared?: boolean;
    /** Replaces methods of the recorded mission port. */
    missions?: Partial<VaubaanMissions>;
    /** The accounts the user holds besides Acme (a Vaubaan account, say). */
    extra?: readonly ReturnType<typeof acmeAccount>[];
  } = {},
) {
  const calls: Call[] = [];
  const account = acmeAccount(options.shared ? { basis: 'share', authority: SHARED } : undefined);
  const preview = (draft: MissionDraft): MissionPreview =>
    previewDraft({ accounts: [account], now: NOW }, draft);
  const record = <T>(method: string, args: readonly unknown[], value: T): Promise<T> => {
    calls.push({ method, args });
    return Promise.resolve(value);
  };
  const missions: VaubaanMissions = {
    issuanceContext: (user) =>
      record('issuanceContext', [user], [account, ...(options.extra ?? [])]),
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
    editView: (user, id) => record('editView', [user, id], null),
    previewEdit: (user, id, raw) =>
      record('previewEdit', [user, id, raw], { ok: false, reason: 'not-found' } as const),
    edit: (user, id, raw, editOptions) =>
      record('edit', [user, id, raw, editOptions], { ok: false, reason: 'not-found' } as const),
    list: (user) => record('list', [user], [] as MissionOverview[]),
    get: (user, id) => record('get', [user, id], null),
    ...options.missions,
  };
  const catalog: VaubaanCatalog = {
    services: () => ['acme'],
    get: (service) =>
      service === 'acme'
        ? {
            service: 'acme',
            service_label: 'Acme',
            derives_env: false,
            risks: enumerateCatalog(ACME_CATALOG),
            macro_actions: macroActionsOf(ACME_CATALOG),
          }
        : null,
  };
  const tools = new VaubaanActs({ missions, catalog, logger: silentLogger });
  const ports = createVaubaanPorts({
    missions,
    catalog,
    plugins: NO_PLUGINS,
    logger: silentLogger,
  });
  return { tools, ports, calls, account };
}

describe('VaubaanActs — every act is the calling mission’s creator’s', () => {
  it('each act calls the mission service with the calling mission’s creator, never another', async () => {
    const { tools, calls } = rig();
    await tools.listMyAccounts(ACTOR);
    await tools.getCatalog(ACTOR, { service: 'acme', account_id: 'conn-acme' });
    await tools.listMyMissions(ACTOR);
    await tools.listMyMissions(ACTOR, { mission_id: 'm1' });
    await tools.previewPolicy(ACTOR, DRAFT);
    await tools.issueMission(ACTOR, DRAFT);
    await tools.previewPolicy(ACTOR, { ...DRAFT, mission_id: 'm1' });
    await tools.renameMission(ACTOR, { mission_id: 'm1', name: 'N' });
    await tools.editMission(ACTOR, { ...DRAFT, mission_id: 'm1' });
    await tools.rotateMissionToken(ACTOR, { mission_id: 'm1' });
    await tools.revokeMission(ACTOR, { mission_id: 'm1' });
    expect(calls.length).toBeGreaterThanOrEqual(11);
    for (const call of calls) {
      expect(call.args[0], call.method).toEqual({ id: ACTOR.userId });
    }
  });

  it('issue passes the calling mission, so the new mission records it and the audit names it', async () => {
    const { tools, calls } = rig();
    const within: MissionDraft = {
      ...DRAFT,
      accounts: [{ account_id: 'conn-acme', trust_levels: { read: 'careful' } }],
    };
    await tools.issueMission(ACTOR, within);
    const issue = calls.find((call) => call.method === 'issue');
    expect(issue?.args[2]).toEqual({ issuedBy: { missionId: ACTOR.missionId } });
  });

  it('a draft beyond the authority is refused before anything is issued, with the uncovered list', async () => {
    const { tools, calls } = rig({ shared: true });
    const outcome = await tools.issueMission(ACTOR, DRAFT);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal).toMatchObject({
      code: 'draft-refused',
      uncovered: [{ account_id: 'conn-acme', service: 'acme', risk_ids: ['acme.admin'] }],
    });
    expect(outcome.refusal.message).toContain('outside the user’s authority');
    expect(calls.some((call) => call.method === 'issue')).toBe(false);
  });

  it('a draft refused for another reason says so, without an uncovered list', async () => {
    const { tools } = rig();
    const outcome = await tools.issueMission(ACTOR, { ...DRAFT, accounts: [] });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal).toMatchObject({ code: 'draft-refused', uncovered: [] });
    expect(outcome.refusal.message).toContain('cannot be issued as written');
  });

  it('a mission that is not the user’s is not found, whatever is asked of it', async () => {
    const { tools, calls } = rig();
    for (const outcome of [
      await tools.listMyMissions(ACTOR, { mission_id: 'm-of-bob' }),
      await tools.rotateMissionToken(ACTOR, { mission_id: 'm-of-bob' }),
      await tools.revokeMission(ACTOR, { mission_id: 'm-of-bob' }),
      await tools.renameMission(ACTOR, { mission_id: 'm-of-bob', name: 'N' }),
      await tools.editMission(ACTOR, { ...DRAFT, mission_id: 'm-of-bob' }),
      await tools.previewPolicy(ACTOR, { ...DRAFT, mission_id: 'm-of-bob' }),
    ]) {
      expect(outcome).toMatchObject({
        ok: false,
        refusal: { code: 'mission-not-found', mission_id: 'm-of-bob' },
      });
    }
    expect(
      calls.some((call) => ['rotate', 'revoke', 'edit', 'previewEdit'].includes(call.method)),
    ).toBe(false);
  });

  describe('rename and edit are the creator’s own "Edit mission", in the calling mission’s name', () => {
    const NO_CHANGE: MissionChanges = {
      name: null,
      expires_at: null,
      accounts_added: [],
      accounts_removed: [],
      resource_sets_added: 0,
      resource_sets_removed: 0,
      resources: [],
      permissions_added: [],
      permissions_removed: [],
      permissions_changed: [],
    };
    const STORED: MissionDraft = {
      ...DRAFT,
      name: 'Old name',
      accounts: [{ account_id: 'conn-acme', trust_levels: { read: 'careful' } }],
    };
    /** The creator's edit form of mission `id`, as `editView` returns it. */
    const editViewOf = (id = 'm1', blocked: MissionEditView['blocked'] = null): MissionEditView =>
      ({
        mission: { id, name: STORED.name },
        snapshot: {},
        draft: STORED,
        revision: 'rev-1',
        blocked,
        lost: [],
      }) as unknown as MissionEditView;
    type EditAnswer = Awaited<ReturnType<VaubaanMissions['edit']>>;
    const edited = (name: string, changes: MissionChanges = NO_CHANGE): EditAnswer =>
      ({
        ok: true,
        mission: { id: 'm1', name },
        changes,
        requests_closed: [],
      }) as unknown as EditAnswer;

    it('rename edits the stored draft with the new name only, from its revision, naming the calling mission', async () => {
      const renamed = { ...NO_CHANGE, name: { before: 'Old name', after: 'New name' } };
      const { tools, calls } = rig({
        missions: {
          editView: async () => editViewOf(),
          edit: async (...args) => {
            calls.push({ method: 'edit', args });
            return edited('New name', renamed);
          },
        },
      });
      const outcome = await tools.renameMission(ACTOR, { mission_id: 'm1', name: 'New name' });
      expect(outcome).toEqual({
        ok: true,
        data: { mission_id: 'm1', name: 'New name', renamed: true },
      });
      const edit = calls.find((call) => call.method === 'edit');
      expect(edit?.args).toEqual([
        { id: ACTOR.userId },
        'm1',
        { draft: { ...STORED, name: 'New name' }, revision: 'rev-1' },
        { issuedBy: { missionId: ACTOR.missionId } },
      ]);
    });

    it('edit applies the draft without its mission id, from the revision just read, naming the calling mission', async () => {
      const added = { ...NO_CHANGE, permissions_added: [{ risk_id: 'acme.read' }] };
      const { tools, calls } = rig({
        missions: {
          editView: async () => editViewOf(),
          edit: async (...args) => {
            calls.push({ method: 'edit', args });
            return edited('Tidy the staging space', added as unknown as MissionChanges);
          },
        },
      });
      const outcome = await tools.editMission(ACTOR, { ...DRAFT, mission_id: 'm1' });
      expect(outcome).toMatchObject({
        ok: true,
        data: { mission_id: 'm1', changed: true, requests_closed: [] },
      });
      const edit = calls.find((call) => call.method === 'edit');
      expect(edit?.args).toEqual([
        { id: ACTOR.userId },
        'm1',
        { draft: DRAFT, revision: 'rev-1' },
        { issuedBy: { missionId: ACTOR.missionId } },
      ]);
    });

    it('a draft equal to the mission answers `renamed: false`', async () => {
      const { tools } = rig({
        missions: { editView: async () => editViewOf(), edit: async () => edited('Old name') },
      });
      expect(await tools.renameMission(ACTOR, { mission_id: 'm1', name: 'Old name' })).toEqual({
        ok: true,
        data: { mission_id: 'm1', name: 'Old name', renamed: false },
      });
    });

    it('the calling mission never renames nor edits itself, nor previews its own edit; the service is not reached', async () => {
      const { tools, calls } = rig({
        missions: { editView: async () => editViewOf(ACTOR.missionId) },
      });
      for (const [act, verb] of [
        [() => tools.renameMission(ACTOR, { mission_id: ACTOR.missionId, name: 'N' }), 'renamed'],
        [() => tools.editMission(ACTOR, { ...DRAFT, mission_id: ACTOR.missionId }), 'edited'],
        [() => tools.previewPolicy(ACTOR, { ...DRAFT, mission_id: ACTOR.missionId }), 'edited'],
      ] as const) {
        const outcome = await act();
        expect(outcome).toMatchObject({
          ok: false,
          refusal: { code: 'self-not-allowed', mission_id: ACTOR.missionId },
        });
        expect(outcome.ok ? '' : outcome.refusal.message).toContain(verb);
      }
      expect(calls.some((call) => call.method === 'edit' || call.method === 'previewEdit')).toBe(
        false,
      );
    });

    it('an edit carrying a Vaubaan account is refused before the service is reached, by id or by service', async () => {
      const vaubaan = { ...acmeAccount(), id: 'conn-vaubaan', service: 'vaubaan' };
      const { tools, calls } = rig({
        extra: [vaubaan],
        missions: { editView: async () => editViewOf() },
      });
      for (const account of [{ account_id: 'conn-vaubaan' }, { service: 'vaubaan' }]) {
        const outcome = await tools.editMission(ACTOR, {
          ...STORED,
          mission_id: 'm1',
          accounts: [...STORED.accounts, { ...account, trust_levels: { read: 'careful' } }],
        });
        expect(outcome).toMatchObject({
          ok: false,
          refusal: { code: 'vaubaan-account-not-allowed' },
        });
        expect(outcome.ok ? '' : outcome.refusal.message).toContain('Nothing was changed');
      }
      expect(calls.some((call) => call.method === 'edit')).toBe(false);
    });

    it.each(['revoked', 'orphaned'] as const)(
      'a %s mission is neither renamed nor edited: mission-inactive, the service is not reached',
      async (state) => {
        const { tools, calls } = rig({
          missions: { editView: async () => editViewOf('m1', state) },
        });
        for (const outcome of [
          await tools.renameMission(ACTOR, { mission_id: 'm1', name: 'N' }),
          await tools.editMission(ACTOR, { ...DRAFT, mission_id: 'm1' }),
        ]) {
          expect(outcome).toMatchObject({
            ok: false,
            refusal: { code: 'mission-inactive', mission_id: 'm1', state },
          });
        }
        expect(calls.some((call) => call.method === 'edit')).toBe(false);
      },
    );

    it('an edit beyond the authority is refused whole, with the uncovered list the service’s issues name', async () => {
      const { tools } = rig({
        missions: {
          editView: async () => editViewOf(),
          edit: async () => ({
            ok: false,
            reason: 'refused',
            issues: [
              {
                code: 'exceeds-authority',
                message: 'Beyond.',
                account_id: 'conn-acme',
                risk_ids: ['acme.admin'],
              },
            ],
            changes: NO_CHANGE,
          }),
        },
      });
      expect(await tools.editMission(ACTOR, { ...DRAFT, mission_id: 'm1' })).toMatchObject({
        ok: false,
        refusal: {
          code: 'draft-refused',
          mission_id: 'm1',
          uncovered: [{ account_id: 'conn-acme', service: 'acme', risk_ids: ['acme.admin'] }],
          changes: NO_CHANGE,
        },
      });
    });

    it('the service’s other answers keep their codes: a race, the ceiling, a vanished mission', async () => {
      const message = 'This gateway holds 3 active missions; its ceiling is 3.';
      const answers: [EditAnswer, Record<string, unknown>][] = [
        [
          { ok: false, reason: 'conflict' },
          { code: 'mission-changed-meanwhile', mission_id: 'm1' },
        ],
        [
          {
            ok: false,
            reason: 'limit-reached',
            message,
            limit: { ceiling: 'active-missions', count: 3, limit: 3, message },
          } as unknown as EditAnswer,
          { code: 'instance-limit-reached', message: `${message} Nothing was changed.` },
        ],
        [{ ok: false, reason: 'not-found' }, { code: 'mission-not-found' }],
        [{ ok: false, reason: 'inactive', state: 'revoked' }, { code: 'mission-inactive' }],
        [
          { ok: false, reason: 'invalid-edit', problems: ['draft.x'] },
          { code: 'invalid-arguments' },
        ],
      ];
      for (const [answer, refusal] of answers) {
        const { tools } = rig({
          missions: { editView: async () => editViewOf(), edit: async () => answer },
        });
        expect(await tools.editMission(ACTOR, { ...DRAFT, mission_id: 'm1' })).toMatchObject({
          ok: false,
          refusal,
        });
      }
    });

    it('preview with `mission_id` is the creator’s preview of an edit: what moves, what is uncovered; nothing written', async () => {
      const { tools, calls } = rig({
        missions: {
          editView: async () => editViewOf(),
          previewEdit: async (...args) => {
            calls.push({ method: 'previewEdit', args });
            return {
              ok: false,
              issues: [
                {
                  code: 'exceeds-authority',
                  message: 'Beyond.',
                  account_id: 'conn-acme',
                  risk_ids: ['acme.admin'],
                },
              ],
              notices: [],
              changes: NO_CHANGE,
              revision: 'rev-1',
            };
          },
        },
      });
      const outcome = await tools.previewPolicy(ACTOR, { ...DRAFT, mission_id: 'm1' });
      expect(outcome).toMatchObject({
        ok: true,
        data: {
          mission_id: 'm1',
          ok: false,
          uncovered: [{ account_id: 'conn-acme', service: 'acme', risk_ids: ['acme.admin'] }],
          changes: NO_CHANGE,
        },
      });
      expect(calls.find((call) => call.method === 'previewEdit')?.args).toEqual([
        { id: ACTOR.userId },
        'm1',
        { draft: DRAFT, revision: 'rev-1' },
      ]);
      expect(calls.some((call) => call.method === 'edit' || call.method === 'preview')).toBe(false);
    });

    it('a mission read by its id carries its draft for its creator, none for a member', async () => {
      const detail = (role: 'creator' | 'member') =>
        ({
          mission: { id: 'm1', name: 'M', accounts: [], policy: [], issuedByMissionId: null },
          state: { kind: 'active', period: { start: NOW.toISOString(), end: null }, remaining: {} },
          role,
          creator: { id: 'user-ada', email: 'ada@example.com' },
          orphan: null,
          lost: [],
          token: null,
          issued_via: null,
          accounts: [],
          policy: [],
        }) as unknown as MissionDetail;
      for (const [role, draft] of [
        ['creator', STORED],
        ['member', null],
      ] as const) {
        const { tools } = rig({
          missions: { get: async () => detail(role), editView: async () => editViewOf() },
        });
        const outcome = await tools.listMyMissions(ACTOR, { mission_id: 'm1' });
        expect(outcome.ok && outcome.data.missions[0]).toMatchObject({ draft });
      }
    });
  });

  describe('rotate reaches only the missions this mission issued (docs/spec/vaubaan-gateway.md §6)', () => {
    /** An active mission of the user, as `get` returns it, issued by `issuer` (or by the human). */
    const activeIssuedBy = (issuer: string | null, id = 'm1'): MissionDetail =>
      ({
        mission: {
          id,
          name: 'M',
          accounts: [],
          policy: [],
          periodSeconds: null,
          issuedByMissionId: issuer,
          issuedViaClientName: null,
        },
        state: { kind: 'active', period: { start: NOW.toISOString(), end: null }, remaining: {} },
        role: 'creator',
        creator: { id: 'user-ada', email: 'ada@example.com' },
        orphan: null,
        lost: [],
        token: null,
        issued_via:
          issuer === null
            ? null
            : { mission_id: issuer, mission_name: 'Caller', client_name: null },
        accounts: [],
        policy: [],
      }) as unknown as MissionDetail;

    it.each([
      ['the user issued in the interface', null],
      ['another mission of the user issued', 'mission-other'],
    ])('refuses a mission %s: nothing is rotated', async (_n, issuer) => {
      const { tools, calls } = rig({
        missions: { get: async () => activeIssuedBy(issuer) },
      });
      const outcome = await tools.rotateMissionToken(ACTOR, { mission_id: 'm1' });
      expect(outcome).toMatchObject({
        ok: false,
        refusal: { code: 'mission-not-issued-here', mission_id: 'm1' },
      });
      expect(outcome.ok ? '' : outcome.refusal.hint).toMatch(/in the web interface/);
      expect(calls.some((call) => call.method === 'rotate')).toBe(false);
    });

    it('rotates a mission this mission issued, and tells the service which mission asks', async () => {
      const { tools, calls } = rig({
        missions: { get: async () => activeIssuedBy(ACTOR.missionId) },
      });
      await tools.rotateMissionToken(ACTOR, { mission_id: 'm1' });
      const rotate = calls.find((call) => call.method === 'rotate');
      expect(rotate?.args).toEqual([
        { id: ACTOR.userId },
        'm1',
        { issuedBy: { missionId: ACTOR.missionId } },
      ]);
    });

    it('the service’s own refusal of a foreign mission reads the same (the two checks agree)', async () => {
      const { tools } = rig({
        missions: {
          get: async () => activeIssuedBy(ACTOR.missionId),
          rotate: async () => ({ ok: false, reason: 'not-issued-by-mission' }),
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
        ...activeIssuedBy(ACTOR.missionId),
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

    it('a listing says which missions this mission issued', () => {
      const view = (issuer: string | null) =>
        missionView(activeIssuedBy(issuer), ACTOR, (prefix) => prefix).issued_via;
      expect(view(null)).toBeNull();
      expect(view(ACTOR.missionId)).toEqual({
        mission_id: ACTOR.missionId,
        mission_name: 'Caller',
        client_name: null,
        this_mission: true,
      });
      expect(view('mission-other')).toMatchObject({ this_mission: false });
    });
  });

  describe('the self rule (ADR platform-management-is-a-plugin-on-the-execution-door)', () => {
    const own = (): MissionDetail =>
      ({
        mission: {
          id: ACTOR.missionId,
          name: 'Platform management',
          accounts: [],
          policy: [],
          periodSeconds: null,
          // Even a mission that issued itself (it cannot) would not act on itself.
          issuedByMissionId: ACTOR.missionId,
          issuedViaClientName: null,
        },
        state: { kind: 'active', period: { start: NOW.toISOString(), end: null }, remaining: {} },
        role: 'creator',
        creator: { id: 'user-ada', email: 'ada@example.com' },
        orphan: null,
        lost: [],
        token: null,
        issued_via: null,
        accounts: [],
        policy: [],
      }) as unknown as MissionDetail;

    it('the calling mission never rotates nor revokes itself, and the service is not reached', async () => {
      const { tools, calls } = rig({ missions: { get: async () => own() } });
      for (const [act, verb] of [
        [() => tools.rotateMissionToken(ACTOR, { mission_id: ACTOR.missionId }), 'rotated'],
        [() => tools.revokeMission(ACTOR, { mission_id: ACTOR.missionId }), 'revoked'],
      ] as const) {
        const outcome = await act();
        expect(outcome).toMatchObject({
          ok: false,
          refusal: { code: 'self-not-allowed', mission_id: ACTOR.missionId },
        });
        expect(outcome.ok ? '' : outcome.refusal.message).toContain(verb);
      }
      expect(calls.some((call) => call.method === 'rotate' || call.method === 'revoke')).toBe(
        false,
      );
    });

    it('a draft carrying a Vaubaan account is refused before any preview, by id or by service', async () => {
      const vaubaan = { ...acmeAccount(), id: 'conn-vaubaan', service: 'vaubaan' };
      const { tools, calls } = rig({ extra: [vaubaan] });
      for (const account of [{ account_id: 'conn-vaubaan' }, { service: 'vaubaan' }]) {
        const outcome = await tools.issueMission(ACTOR, {
          ...DRAFT,
          accounts: [
            { account_id: 'conn-acme', trust_levels: { read: 'careful' } },
            { ...account, trust_levels: { read: 'careful' } },
          ],
        });
        expect(outcome).toMatchObject({
          ok: false,
          refusal: { code: 'vaubaan-account-not-allowed' },
        });
      }
      expect(calls.map((call) => call.method)).toEqual(['issuanceContext', 'issuanceContext']);
    });

    it('a teammate’s key is refused at the port; the creator’s own key and a machine key pass', async () => {
      const { ports, calls } = rig();
      const teammate = await ports.listMyAccounts({ ...ACTOR, holderUserId: 'user-grace' }, {});
      expect(teammate).toMatchObject({
        ok: false,
        refusal: { code: 'teammate-key-not-allowed' },
      });
      expect(calls).toEqual([]);
      expect(await ports.listMyAccounts(ACTOR, {})).toMatchObject({ ok: true });
      expect(await ports.listMyAccounts({ ...ACTOR, holderUserId: null }, {})).toMatchObject({
        ok: true,
      });
    });

    it('arguments are read by the port: an unknown key is `invalid-arguments`, naming where', async () => {
      const { ports, calls } = rig();
      const outcome = await ports.revokeMission(ACTOR, { mission_id: 'm1', force: true });
      expect(outcome).toMatchObject({ ok: false, refusal: { code: 'invalid-arguments' } });
      expect(calls).toEqual([]);
    });
  });

  describe('the mission service decides last: its answer after the door’s own check stands', () => {
    const within: MissionDraft = {
      ...DRAFT,
      accounts: [{ account_id: 'conn-acme', trust_levels: { read: 'careful' } }],
    };
    /** A mission of the user that serves calls, as `get` returns it. */
    const active = {
      mission: {
        id: 'm1',
        name: 'M',
        accounts: [],
        policy: [],
        periodSeconds: null,
        issuedByMissionId: ACTOR.missionId,
        issuedViaClientName: null,
      },
      state: { kind: 'active', period: { start: NOW.toISOString(), end: null }, remaining: {} },
      role: 'creator',
      creator: { id: 'user-ada', email: 'ada@example.com' },
      orphan: null,
      token: null,
      issued_via: { mission_id: ACTOR.missionId, mission_name: 'Caller', client_name: null },
      accounts: [],
      policy: [],
    } as unknown as MissionDetail;

    it('issue refuses a draft the preview accepted (the authority changed in between): draft-refused, with the service’s preview', async () => {
      // The recorded `issue` answers `refused`, although `preview` said the draft passes.
      const { tools, calls } = rig();
      const outcome = await tools.issueMission(ACTOR, within);
      expect(calls.map((call) => call.method)).toEqual(['issuanceContext', 'preview', 'issue']);
      expect(outcome).toMatchObject({
        ok: false,
        refusal: { code: 'draft-refused', uncovered: [], preview: { name: within.name } },
      });
    });

    it('the instance’s ceiling of active missions is a refusal code of its own', async () => {
      const message = 'This gateway holds 3 active missions; its ceiling is 3.';
      const { tools } = rig({
        missions: {
          issue: async () => ({
            ok: false,
            reason: 'limit-reached',
            message,
            limit: { ceiling: 'active-missions', count: 3, limit: 3, message },
          }),
        },
      });
      const outcome = await tools.issueMission(ACTOR, within);
      expect(outcome).toMatchObject({
        ok: false,
        refusal: {
          code: 'instance-limit-reached',
          message: `${message} Nothing was issued.`,
          count: 3,
          ceiling: 3,
        },
      });
      if (!outcome.ok) expect(outcome.refusal.hint).toMatch(/revoke a mission|raise the ceiling/);
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
        '../../../../../docs/handbook/services/vaubaan.md',
      ),
      'utf8',
    );
    const table = handbook.slice(handbook.indexOf('| `error.code`'));
    const documented = [...table.slice(0, table.indexOf('\n\n')).matchAll(/^\| `([a-z-]+)`/gm)]
      .map((match) => match[1])
      .filter((code) => code !== 'error.code');
    // `internal-error` is the plugin's own (a port that threw), not an act's refusal.
    expect(documented.sort()).toEqual([...VAUBAAN_REFUSAL_CODES, 'internal-error'].sort());
  });

  it('get_catalog names the services when asked for one that does not exist', async () => {
    const { tools } = rig();
    expect(await tools.getCatalog(ACTOR, { service: 'nope' })).toMatchObject({
      ok: false,
      refusal: { code: 'unknown-service', services: ['acme'] },
    });
    expect(await tools.getCatalog(ACTOR, { service: 'acme', account_id: 'x' })).toMatchObject({
      ok: false,
      refusal: { code: 'unknown-account' },
    });
  });
});

describe('views', () => {
  it('an account shows its exact restriction and which env-qualified ids are usable', () => {
    const owner = accountView(acmeAccount());
    expect(owner.authority).toMatchObject({ basis: 'owner', whole_catalog: true });
    expect(owner.env_qualified_risks).toEqual({
      derives_env: false,
      default_env: null,
      labelled_envs: ['staging', 'prod'],
      unlabelled_resources: ['scratch'],
      usable_risk_ids: ['acme[staging].write', 'acme[prod].write', 'acme[staging].bulk-delete'],
      unusable_risk_ids: [],
    });
    expect(owner.macro_actions.every((action) => action.unavailable.length === 0)).toBe(true);

    const shared = accountView(acmeAccount({ basis: 'share', authority: SHARED }));
    expect(shared.authority).toEqual({ basis: 'share', risk_ids: SHARED, whole_catalog: false });
    const actions = Object.fromEntries(shared.macro_actions.map((action) => [action.id, action]));
    expect(actions.read?.unavailable).toEqual([]);
    expect(actions.change?.unavailable).toEqual(['acme[prod].write', 'acme[staging].bulk-delete']);
    expect(actions.administer?.unavailable).toEqual(['acme.admin']);
  });

  it('a macro-action says what each trust level writes, with the mission module’s own expansion', () => {
    const owner = accountView(acmeAccount());
    const change = owner.macro_actions.find((action) => action.id === 'change');
    // Writes are costly (row 3), bulk deletes irreversible (row 4).
    expect(change?.at_trust_level).toEqual({
      careful: { auto: 0, approval: 2, left_out: 1 },
      trusting: { auto: 0, approval: 3, left_out: 0 },
      autonomous: { auto: 2, approval: 1, left_out: 0 },
    });
    expect(owner.macro_actions.map((action) => action.id)).toEqual([
      'read',
      'change',
      'administer',
      'anything-else',
    ]);
  });

  it('env usability is `isResolvable` on the resources a mission can select: a stale label does not count', () => {
    const onlyStaleProd = acmeAccount({
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
    const view = accountView(onlyStaleProd).env_qualified_risks;
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
          accounts: [],
          policy: [],
        },
        role: 'creator',
        creator: { id: 'user-ada', email: 'ada@example.com' },
        state: { kind: 'orphaned' },
        orphan: { cause, account_id: 'conn-acme', uncovered: ['acme.read'] },
        lost: [],
        token: null,
        issued_via: null,
      }) as unknown as MissionOverview;
    const causes = [
      'creator-removed',
      'account-missing',
      'account-revoked',
      'authority-lost',
    ] as const;
    const answers = causes.map((cause) => {
      const view = missionView(overview(cause), ACTOR, (prefix) => prefix);
      const orphan = { cause, account_id: 'conn-acme', uncovered: ['acme.read' as RiskId] };
      expect(view.orphan?.can_come_back, cause).toBe(explainOrphan(orphan, []).reversible);
      return view.orphan?.can_come_back;
    });
    expect(answers).toEqual([true, false, false, true]);
  });

  it('with no labelled resource, env-qualified ids are unusable unless the service derives the environment', () => {
    const unlabelled = acmeAccount({
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
    const view = accountView(unlabelled).env_qualified_risks;
    expect(view.usable_risk_ids).toEqual([]);
    expect(view.unusable_risk_ids).toEqual([
      'acme[staging].write',
      'acme[prod].write',
      'acme[staging].bulk-delete',
    ]);
    const derived = accountView({ ...unlabelled, derives_env: true }).env_qualified_risks;
    expect(derived.unusable_risk_ids).toEqual([]);
  });

  it('stale resources are not offered; hidden ones are, flagged', () => {
    const view = accountView(
      acmeAccount({
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
    const view = accountView(
      acmeAccount({
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

  it('the catalog is explicit ids; an account flags each one', () => {
    const { tools: _tools, account } = rig({ shared: true });
    const catalog = {
      service: 'acme',
      service_label: 'Acme',
      derives_env: false,
      risks: enumerateCatalog(ACME_CATALOG),
      macro_actions: macroActionsOf(ACME_CATALOG),
    };
    const plain = catalogView(catalog, null);
    expect(plain.risks.map((risk) => risk.risk_id)).toContain('acme[prod].write');
    expect(plain.risks.every((risk) => !('in_my_authority' in risk))).toBe(true);
    const flagged = catalogView(catalog, account);
    expect(
      flagged.risks.filter((risk) => risk.in_my_authority).map((risk) => risk.risk_id),
    ).toEqual(SHARED);
    // Each risk says its row and macro-action; the trust levels say what a row gets.
    expect(plain.risks.find((risk) => risk.risk_id === 'acme[staging].bulk-delete')).toMatchObject({
      row: 4,
      macro_action: 'change',
    });
    expect(plain.risks.find((risk) => risk.risk_id === 'acme.legacy-export')?.macro_action).toBe(
      null,
    );
    expect(plain.macro_actions.map((action) => action.id)).toContain('anything-else');
    expect(plain.trust_levels.careful).toEqual({
      gates: { '1': 'auto', '2': 'approval', '3': 'approval', '4': null },
      budget_factor: 1,
    });
  });

  it('the built-in `everything-i-hold` is listed last, within the authority, counted on the resources known now', () => {
    const shared = acmeAccount({ basis: 'share', authority: SHARED });
    expect(accountView(shared).everything_i_hold).toMatchObject({
      label: 'Everything I hold on this account',
      risks: 2,
    });
    // An owner holds the whole catalog: every non-deprecated id, the fallback included.
    expect(accountView(acmeAccount()).everything_i_hold.risks).toBe(6);

    const catalog = {
      service: 'acme',
      service_label: 'Acme',
      derives_env: false,
      risks: enumerateCatalog(ACME_CATALOG),
      macro_actions: macroActionsOf(ACME_CATALOG),
    };
    // Without an account there is nothing to write out: it is not listed.
    expect(catalogView(catalog, null).everything_i_hold).toBeUndefined();
    const written = catalogView(catalog, shared).everything_i_hold;
    expect(written?.entries.map((e) => e.risk_id)).toEqual(SHARED);
  });

  it('preview and issue accept `everything-i-hold`: the policy is the explicit list', () => {
    const draft: MissionDraft = {
      ...DRAFT,
      accounts: [{ account_id: 'conn-acme', everything_i_hold: true }],
    };
    // One environment: the staging resources (a set holds one, risk model §4.7).
    const staging = ACME_RESOURCES.filter((r) => r.env === 'staging');
    const preview = previewDraft(
      {
        accounts: [acmeAccount({ basis: 'share', authority: SHARED, resources: staging })],
        now: NOW,
      },
      draft,
    );
    const view = previewView(preview);
    expect(view.ok).toBe(true);
    expect(view.policy.map((line) => line.risk_id)).toEqual(SHARED);
    expect(view.accounts[0]?.everything_i_hold).toBe(true);
    expect(view.notices.map((n) => n.code)).toContain('everything-i-hold-expanded');
  });

  it('a preview carries the uncovered list per account', () => {
    const preview = previewDraft(
      { accounts: [acmeAccount({ basis: 'share', authority: SHARED })], now: NOW },
      DRAFT,
    );
    expect(uncoveredOfPreview(preview)).toEqual([
      { account_id: 'conn-acme', service: 'acme', risk_ids: ['acme.admin'] },
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
        issuedByMissionId: 'mission-other',
        issuedViaClientName: null,
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
        closedAt: null,
        accounts: [
          {
            accountId: 'conn-acme',
            resourceSets: [
              {
                id: 'set-1',
                position: 1,
                resourceIds: [],
                future: false,
                env: null,
                mixedEnv: false,
              },
            ],
          },
        ],
        policy: [
          {
            resourceSetId: 'set-1',
            riskId: 'acme.read',
            quota: 5,
            rateLimit: 2,
            rateWindowSeconds: 60,
            gate: 'approval',
          },
        ],
      },
      role: 'creator',
      creator: { id: 'user-ada', email: 'ada@example.com' },
      state: { kind: 'orphaned' },
      orphan: { cause: 'account-revoked', account_id: 'conn-acme', uncovered: [] },
      lost: [{ account_id: 'conn-acme', cause: 'account-revoked', final: true }],
      token: { prefix: 'AbCd1234', created_at: NOW.toISOString() },
      issued_via: { mission_id: 'mission-other', mission_name: 'Other', client_name: null },
    } as MissionOverview;
    const view = missionView(overview, ACTOR, (prefix) => `masked:${prefix}`);
    expect(view).toMatchObject({
      mission_id: 'm1',
      state: 'orphaned',
      orphan: { cause: 'account-revoked', can_come_back: false },
      lost_accounts: [{ account_id: 'conn-acme', cause: 'account-revoked', final: true }],
      period: { kind: 'recurring', length_seconds: 3600 },
      session: null,
      issued_via: {
        mission_id: 'mission-other',
        mission_name: 'Other',
        client_name: null,
        this_mission: false,
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
    const text = Object.fromEntries(
      vaubaanTools.map((tool) => [tool.name.replace('vaubaan__', ''), tool.description]),
    );
    expect(text.list_my_accounts).toContain('exact list of RiskIds');
    expect(text.list_my_accounts).toContain('unlabelled resources refuse it');
    expect(text.get_catalog).toContain('explicit RiskIds');
    expect(text.get_catalog).toContain('macro_actions');
    expect(text.preview_policy).toContain('explicit RiskIds only');
    expect(text.preview_policy).toContain('one account per service');
    expect(text.preview_policy).toContain('a quota and a rate limit for every risk');
    expect(text.preview_policy).toContain('labelled with that environment');
    // `all` and future resources are told apart where a draft is composed.
    expect(text.preview_policy).toContain("`{ scope: 'account' }` — `all` with `future: true`");
    expect(text.preview_policy).toContain('a resource discovered later is not reached');
    expect(text.preview_policy).toContain('`resource-set-mixed-env`');
    expect(text.issue_mission).toContain("`resources: { scope: 'account' }`");
    expect(text.list_my_missions).toContain('`resource_selections`');
    expect(text.preview_policy).toContain('A set holds one environment');
    expect(text.list_my_accounts).toContain('Order of the calls');
    expect(text.issue_mission).toContain('`vaubaan-account-not-allowed`');
    expect(text.rotate_mission_token).toContain('`self-not-allowed`');
    expect(text.rename_mission).toContain('`self-not-allowed`');
    expect(text.edit_mission).toContain('`self-not-allowed`');
    expect(text.edit_mission).toContain('`vaubaan-account-not-allowed`');
    expect(text.edit_mission).toContain('nothing is narrowed silently');
    expect(text.preview_policy).toContain('With `mission_id`, previews an edit');
    expect(text.issue_mission).toContain('The creator is the user, not you');
    expect(text.issue_mission).toContain('shown this once');
    expect(text.issue_mission).toContain('they alone answer the requests');
    expect(text.rotate_mission_token).toContain('orphaned mission is not rotated');
    expect(text.revoke_mission).toContain('orphaned mission can be revoked');
    for (const tool of vaubaanTools) {
      expect(tool.description.length, tool.name).toBeLessThan(1600);
    }
  });

  it('the draft tools refuse an unknown key and a non-draft at the schema', () => {
    const preview = { inputSchema: VAUBAAN_INPUTS.previewPolicy };
    expect(preview.inputSchema.safeParse(DRAFT).success).toBe(true);
    expect(preview.inputSchema.safeParse({ ...DRAFT, accepted_risks: ['*'] }).success).toBe(false);
    expect(preview.inputSchema.safeParse({ name: 'x' }).success).toBe(false);
    const whole = (resources: unknown) => ({
      ...DRAFT,
      accounts: [{ ...DRAFT.accounts[0], resources }],
    });
    expect(preview.inputSchema.safeParse(whole({ scope: 'account' })).success).toBe(true);
    expect(
      preview.inputSchema.safeParse(whole({ scope: 'account', resource_ids: ['r1'] })).success,
    ).toBe(false);
    expect(preview.inputSchema.safeParse(whole({ scope: 'everything' })).success).toBe(false);
    // A preview may name the mission it would edit; an edit must.
    expect(preview.inputSchema.safeParse({ ...DRAFT, mission_id: 'm1' }).success).toBe(true);
    expect(VAUBAAN_INPUTS.editMission.safeParse({ ...DRAFT, mission_id: 'm1' }).success).toBe(true);
    expect(VAUBAAN_INPUTS.editMission.safeParse(DRAFT).success).toBe(false);
    expect(
      VAUBAAN_INPUTS.editMission.safeParse({ ...DRAFT, mission_id: 'm1', force: true }).success,
    ).toBe(false);
    // A name follows issuance's rule: not empty, not blank, at most 120 characters.
    const rename = (name: string) =>
      VAUBAAN_INPUTS.renameMission.safeParse({ mission_id: 'm1', name }).success;
    expect(rename('Fix the docs')).toBe(true);
    expect(rename('x'.repeat(120))).toBe(true);
    expect(rename('x'.repeat(121))).toBe(false);
    expect(rename('')).toBe(false);
    expect(rename('   ')).toBe(false);
    const revoke = { inputSchema: VAUBAAN_INPUTS.revokeMission };
    expect(revoke.inputSchema.safeParse({ mission_id: 'm1' }).success).toBe(true);
    expect(revoke.inputSchema.safeParse({ mission_id: 'm1', force: true }).success).toBe(false);
    expect(revoke.inputSchema.safeParse({}).success).toBe(false);
  });

  it('the plugin declares, as JSON Schema, exactly the arguments the host reads (`npm run vaubaan:schemas`)', () => {
    const declared = Object.fromEntries(
      vaubaanTools.map((tool) => [tool.name.replace('vaubaan__', ''), tool.inputSchema]),
    );
    expect(declared).toEqual(toolSchemasDocument());
  });

  it('an answer is structured content, also serialized as text; a refusal is a tool error with its code', () => {
    const ok = toolResultOf({ ok: true, data: { accounts: [] } });
    expect(ok).toEqual({
      content: [{ type: 'text', text: JSON.stringify({ accounts: [] }, null, 2) }],
      structuredContent: { accounts: [] },
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
