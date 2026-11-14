/**
 * Trust-raise proposals (risk model §4.7) through the real root: approvals granted on
 * one macro-action of one resource set are counted until the threshold, then the
 * mission page offers to raise its trust level by one; a refusal, a "Not now" or an
 * edit of that trust level starts the count again; a macro-action at Autonomous is
 * never offered; nothing is ever raised without an edit.
 *
 * The threshold is 3 here (`VAUBAAN_TRUST_RAISE_AFTER_APPROVALS`); its default is
 * pinned by `config/trust-raise-config.test.ts`.
 */
import { draftAccountOf } from '@/lib/missions/mission-edit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { MissionDraft } from '../../../src/server/missions';
import {
  DEPOT,
  executionInstance,
  line,
  type ExecutionInstance,
  type IssuedMission,
} from '../../support/execution/testing';

/** Env-scoped: counted on its macro-action through its base id `depot.write`. */
const WRITE = `${DEPOT}[staging].write`;
const READ = `${DEPOT}.read`;
const THRESHOLD = 3;

describe('trust-raise proposals', () => {
  let instance: ExecutionInstance;
  let item = 0;

  beforeEach(async () => {
    instance = await executionInstance({
      env: { VAUBAAN_TRUST_RAISE_AFTER_APPROVALS: String(THRESHOLD) },
    });
  });
  afterEach(() => instance.close());

  /** Writes gated "ask me first", the macro-action `change` stored at `level`. */
  async function issue(level = 'careful'): Promise<IssuedMission> {
    const draft: MissionDraft = {
      name: 'Raise me',
      accounts: [
        {
          account_id: instance.account.id,
          resources: { scope: 'selected', resource_refs: ['app-staging'] },
          policy: [line(READ), line(WRITE, 100, { gate: 'approval' })],
          trust_levels: { change: level },
        },
      ],
      period: { kind: 'recurring', length_seconds: 86_400 },
      expires_at: null,
    };
    const result = await instance.root.missions.service.issue(instance.ada, draft);
    if (!result.ok) throw new Error(`issue refused: ${JSON.stringify(result)}`);
    return { mission: result.mission, token: result.token.secret, prefix: result.token.prefix };
  }

  /** One gated write asked, and the creator's answer to it. */
  async function answer(issued: IssuedMission, resolution: 'grant' | 'refuse') {
    item += 1;
    const asked = await instance.call(issued, 'depot__write_item', {
      space: 'app-staging',
      item: `i-${item}`,
    });
    expect(asked.error?.data).toMatchObject({ code: 'approval-required' });
    const id = String(asked.error?.data?.approval_url).split('/').at(-1) ?? '';
    const decided = await instance.root.requests.service.decide(instance.ada, id, { resolution });
    expect(decided).toMatchObject({ ok: true });
  }

  const offersOf = async (issued: IssuedMission) =>
    (await instance.root.missions.service.get(instance.ada, issued.mission.id))?.trust_raises ?? [];

  it('is offered after the threshold of approvals, one level up, and raises nothing by itself', async () => {
    const issued = await issue();
    for (let i = 0; i < THRESHOLD - 1; i++) await answer(issued, 'grant');
    expect(await offersOf(issued)).toEqual([]);
    await answer(issued, 'grant');
    expect(await offersOf(issued)).toEqual([
      expect.objectContaining({
        account_name: 'Depot main',
        macro_action_id: 'change',
        macro_action_label: 'Change',
        from: 'careful',
        to: 'trusting',
        approvals: THRESHOLD,
        several_sets: false,
      }),
    ]);
    // Nothing moved: the line still asks first.
    const record = await instance.root.store.missions.getById(issued.mission.id);
    expect(record?.policy.find((p) => p.riskId === WRITE)?.gate).toBe('approval');
    // The Now page offers it too, with its mission.
    const now = await instance.root.missions.service.trustRaisesFor(instance.ada);
    expect(now.map((m) => [m.mission_id, m.offers.length])).toEqual([[issued.mission.id, 1]]);
  });

  it('starts again after a refusal', async () => {
    const issued = await issue();
    for (let i = 0; i < THRESHOLD - 1; i++) await answer(issued, 'grant');
    await answer(issued, 'refuse');
    await answer(issued, 'grant');
    expect(await offersOf(issued)).toEqual([]);
    for (let i = 0; i < THRESHOLD - 1; i++) await answer(issued, 'grant');
    expect(await offersOf(issued)).toHaveLength(1);
  });

  it('"Not now" hides it until as many approvals again; the creator only', async () => {
    const issued = await issue();
    for (let i = 0; i < THRESHOLD; i++) await answer(issued, 'grant');
    const [offer] = await offersOf(issued);
    const target = {
      resource_set_id: offer!.resource_set_id,
      macro_action_id: offer!.macro_action_id,
    };
    const stranger = await instance.root.store.users.upsertFromIdp({
      issuer: 'http://idp.test',
      subject: 'idp|eve',
      email: 'eve@example.com',
      displayName: 'Eve',
    });
    const service = instance.root.missions.service;
    expect(await service.snoozeTrustRaise(stranger, issued.mission.id, target)).toBeNull();
    expect(
      await service.snoozeTrustRaise(instance.ada, issued.mission.id, {
        ...target,
        resource_set_id: 'not-a-set',
      }),
    ).toBeNull();
    expect(await service.snoozeTrustRaise(instance.ada, issued.mission.id, target)).toEqual({
      ok: true,
    });
    expect(await offersOf(issued)).toEqual([]);
    for (let i = 0; i < THRESHOLD - 1; i++) await answer(issued, 'grant');
    expect(await offersOf(issued)).toEqual([]);
    await answer(issued, 'grant');
    expect(await offersOf(issued)).toHaveLength(1);
    // "Raise" opens the edit with that offer only for the creator.
    expect(await service.trustRaiseOffer(instance.ada, issued.mission.id, target)).not.toBeNull();
    expect(await service.trustRaiseOffer(stranger, issued.mission.id, target)).toBeNull();
  });

  it('starts again once an edit changes that trust level, and is never offered at Autonomous', async () => {
    const issued = await issue();
    for (let i = 0; i < THRESHOLD; i++) await answer(issued, 'grant');
    expect(await offersOf(issued)).toHaveLength(1);

    const service = instance.root.missions.service;
    const view = await service.editView(instance.ada, issued.mission.id);
    if (!view || view.blocked) throw new Error('edit view missing');
    const [account] = view.snapshot.accounts;
    const draft = draftAccountOf(account!);
    const edited = await service.edit(instance.ada, issued.mission.id, {
      revision: view.revision,
      draft: {
        name: view.snapshot.name,
        period: view.snapshot.period,
        expires_at: view.snapshot.expires_at,
        // A trust level moved alone is no edit (`hasChanges`): a raise rewrites its lines.
        accounts: [
          {
            ...draft,
            trust_levels: { change: 'trusting' },
            policy: (draft.policy ?? []).map((p) =>
              p.risk_id === WRITE ? { ...p, quota: 50 } : p,
            ),
          },
        ],
      },
    });
    expect(edited).toMatchObject({ ok: true });
    expect(await offersOf(issued)).toEqual([]);
    for (let i = 0; i < THRESHOLD; i++) await answer(issued, 'grant');
    expect(await offersOf(issued)).toEqual([
      expect.objectContaining({ from: 'trusting', to: 'autonomous' }),
    ]);

    const top = await issue('autonomous');
    for (let i = 0; i < THRESHOLD; i++) await answer(top, 'grant');
    expect(await offersOf(top)).toEqual([]);
  });
});
