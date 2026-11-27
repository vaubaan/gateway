/**
 * The starter mission (spec §7.4; intent "Start from a mission filled in for the account
 * I just connected"): the creation form filled in for one account — everything ticked
 * at Careful, what reads passing on its own, what writes or destroys waiting for a yes,
 * what cannot be repaired left out — checked against the shipped catalogs.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { starterMissionDraft } from '../../../src/app/(app)/missions/new/form-state';
import type { GatewayRoot } from '../../../src/server/compose/root';
import { buildTestRoot, seedInstance, type SeededInstance } from './support';

describe('the starter mission of an account', () => {
  let root: GatewayRoot;
  let seeded: SeededInstance;

  beforeEach(async () => {
    root = await buildTestRoot();
    seeded = await seedInstance(root);
  });
  afterEach(async () => {
    await root.close();
  });

  it('is filled in for the whole account: what reads asks nothing, what writes or destroys waits for a yes, row 4 is left out', async () => {
    const { service } = root.missions;
    for (const account of await service.issuanceContext(seeded.ada)) {
      const draft = starterMissionDraft(account);
      expect(draft.name).toBe(`${account.service_label} · ${account.display_name}`);
      const lines = draft.accounts[0]?.policy ?? [];
      expect(lines.length, account.service).toBeGreaterThan(0);
      const byId = new Map(account.risks.map((risk) => [risk.risk_id, risk]));
      for (const line of lines) {
        const risk = byId.get(line.risk_id);
        expect(risk?.fallback, line.risk_id).toBe(false);
        expect(risk?.row, line.risk_id).not.toBe(4);
        expect(line.gate, line.risk_id).toBe(risk?.kind === 'read' ? 'auto' : 'approval');
      }
    }
  });

  it('is a draft the gateway would issue as it stands, for a service that takes a pasted key', async () => {
    const { service } = root.missions;
    const github = (await service.issuanceContext(seeded.ada)).find((c) => c.service === 'github');
    if (!github) throw new Error('no github account seeded');
    const draft = starterMissionDraft(github);
    const preview = await service.preview(seeded.ada, draft);
    expect(preview.issues).toEqual([]);
    expect(preview.ok).toBe(true);
    // The explicit lines survive the preview with their gates: the form shows what is sent.
    const sent = new Map((draft.accounts[0]?.policy ?? []).map((l) => [l.risk_id, l.gate]));
    const resolved = preview.resolved.flatMap((a) => a.resource_sets.flatMap((s) => s.policy));
    expect(resolved.length).toBeGreaterThan(0);
    for (const line of resolved) expect(line.gate, line.risk_id).toBe(sent.get(line.risk_id));
    const issued = await service.issue(seeded.ada, draft);
    expect(issued.ok).toBe(true);
  });
});
