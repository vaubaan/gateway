/**
 * Missions end to end inside the process (spec §10 "integration on an
 * ephemeral instance"): the composition root on the `:memory:` store, real
 * plugin catalogs and their macro-actions, accounts and resources seeded through the
 * repositories. Issue → the token verifies → rotate → the old token is
 * refused → revoke → `mission-inactive`.
 */
import { checkMissionActive } from '@vaubaan/gateway-core';
import { unqualifyRiskId } from '@vaubaan/policy-engine';
import { digestApiKey } from '@vaubaan/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { GatewayRoot } from '../../../src/server/compose/root';
import { loadMissionContext } from '../../../src/server/execution/mission-context';
import {
  macroActionsOf,
  MissionService,
  TRUST_LEVELS,
  type MissionDraft,
} from '../../../src/server/missions';
import { catalogEnvs, seedAccount } from '../../support/missions/testing';
import { ManualClock } from '../../../src/server/store/clock';
import { agePastStaleGrace, flatAccounts, flatPolicy } from '../../support/store/testing';
import { buildTestRoot, seedInstance, type SeededInstance } from './support';

const DAILY = { kind: 'recurring', length_seconds: 86_400 } as const;
/**
 * Read and propose at Trusting: reads, pushes and pull requests run freely,
 * a force-push or a branch delete asks first.
 */
const DEVELOPER_TRUST_LEVELS = { read: 'trusting', propose: 'trusting' } as const;
/** What the former Supabase `staging-developer` preset stood for: query, change data, schema and functions. */
const SUPABASE_STAGING_TRUST_LEVELS = {
  query: 'trusting',
  'change-data': 'trusting',
  'change-schema': 'trusting',
  'ship-functions': 'trusting',
} as const;
/** Watch and deploy on Vercel at Trusting. */
const VERCEL_DEVELOPER_TRUST_LEVELS = { watch: 'trusting', deploy: 'trusting' } as const;

describe('missions: issue, rotate, revoke', () => {
  let root: GatewayRoot;
  let seeded: SeededInstance;
  let missions: MissionService;

  beforeEach(async () => {
    root = await buildTestRoot();
    seeded = await seedInstance(root);
    missions = root.missions.service;
  });
  afterEach(async () => {
    await root.close();
  });

  function githubDraft(overrides: Partial<MissionDraft> = {}): MissionDraft {
    return {
      name: 'Ship the billing page',
      accounts: [{ account_id: seeded.github.account.id, trust_levels: DEVELOPER_TRUST_LEVELS }],
      period: DAILY,
      expires_at: null,
      ...overrides,
    };
  }

  /** The risk ids the named GitHub macro-actions hold, as the catalog ships them. */
  function githubActionRows(ids: readonly string[]): string[] {
    const github = root.registry.get('github');
    if (!github) throw new Error('github is not registered');
    return macroActionsOf(github.plugin.catalog)
      .filter((action) => ids.includes(action.id))
      .flatMap((action) => action.entries.map((entry) => entry.risk_id));
  }

  async function issued(draft: MissionDraft = githubDraft(), user = seeded.ada) {
    const result = await missions.issue(user, draft);
    if (!result.ok) throw new Error(`issue refused: ${JSON.stringify(result)}`);
    return result;
  }

  it('issue → token verifies → rotate → old token refused → revoke → mission-inactive', async () => {
    const first = await issued();
    expect(first.token.secret).toMatch(/^vbn_live_[A-Za-z0-9]{8}_[A-Za-z0-9]{32}$/);

    const verified = await missions.verifyToken(first.token.secret);
    if (verified.outcome !== 'verified') throw new Error('expected a verified token');
    expect(verified.mission.id).toBe(first.mission.id);
    // The door gets the token's id, prefix and holder, never the stored hash.
    expect(Object.keys(verified.token).sort()).toEqual(['holder', 'id', 'prefix']);
    // A mission is born with its creator's own member token.
    expect(verified.token.holder).toEqual({
      kind: 'member',
      user_id: seeded.ada.id,
      display: seeded.ada.email,
    });
    expect(verified.token.prefix).toBe(first.token.prefix);
    const ctx = await loadMissionContext(root.store, verified.mission, verified.token, []);
    expect(checkMissionActive(ctx, new Date(first.mission.createdAt))).toBeNull();

    const rotated = await missions.rotate(seeded.ada, first.mission.id);
    if (!rotated.ok) throw new Error('rotate refused');
    expect(rotated.token.secret).not.toBe(first.token.secret);
    expect(rotated.mission.id).toBe(first.mission.id);

    const old = await missions.verifyToken(first.token.secret);
    expect(old).toMatchObject({ outcome: 'retired', reason: 'rotated' });
    const fresh = await missions.verifyToken(rotated.token.secret);
    expect(fresh.outcome).toBe('verified');

    const revoked = await missions.revoke(seeded.ada, first.mission.id);
    expect(revoked).toMatchObject({ ok: true, tokensRevoked: 1 });

    const after = await missions.verifyToken(rotated.token.secret);
    expect(after).toMatchObject({ outcome: 'retired', reason: 'revoked' });
    if (after.outcome !== 'retired') throw new Error('expected a retired token');
    const refusal = checkMissionActive(
      await loadMissionContext(root.store, after.mission, after.token, []),
      new Date(first.mission.createdAt),
    );
    expect(refusal).toMatchObject({ code: 'mission-inactive', status: 'revoked' });
    // The token replaced by rotation stays what it was: replaced, not revoked.
    expect(await missions.verifyToken(first.token.secret)).toMatchObject({ reason: 'rotated' });
  });

  it('answers the same for a malformed bearer, an unknown prefix and a wrong secret', async () => {
    const { token } = await issued();
    const wrongSecret = `vbn_live_${token.prefix}_${'x'.repeat(32)}`;
    for (const bearer of ['', 'Bearer x', `vbn_live_ZZZZZZZZ_${'y'.repeat(32)}`, wrongSecret]) {
      expect(await missions.verifyToken(bearer)).toEqual({ outcome: 'unknown' });
    }
  });

  it('persists the explicit enumeration: resource ids, policy entries, no preset reference', async () => {
    const { mission, preview } = await issued();
    expect(mission.creatorUserId).toBe(seeded.ada.id);
    expect(mission.periodSeconds).toBe(86_400);
    expect(mission.expiresAt).toBeNull();
    expect(flatAccounts(mission)).toEqual([
      {
        accountId: seeded.github.account.id,
        resourceIds: seeded.github.resources.map((r) => r.id).sort(),
        // Kept only to redraw the form: the policy below is what decides.
        trustLevels: DEVELOPER_TRUST_LEVELS,
      },
    ]);
    // Every row of the two macro-actions: at Trusting, none is left out.
    expect(mission.policy.map((e) => e.riskId).sort()).toEqual(
      githubActionRows(Object.keys(DEVELOPER_TRUST_LEVELS)).sort(),
    );
    expect(mission.policy.map((e) => e.riskId).sort()).toEqual(
      preview.policy.map((e) => e.risk_id).sort(),
    );
    expect(mission.policy.every((e) => e.quota >= 1 && e.rateLimit >= 1)).toBe(true);
    expect(preview.accounts[0]?.left_out).toEqual([]);
    expect(JSON.stringify(mission)).not.toContain('preset');
  });

  it('does not cover a resource discovered after issuance', async () => {
    const { mission } = await issued();
    await root.store.accounts.syncDiscoveredResources(seeded.github.account.id, [
      ...seeded.github.resources.map((r) => ({ ref: r.ref, displayName: r.displayName })),
      { ref: 'acme/new-repo', displayName: 'acme/new-repo' },
    ]);
    const reread = await root.store.missions.getById(mission.id);
    expect(reread?.accounts[0]?.resourceSets[0]?.resourceIds).toHaveLength(3);
    const detail = await missions.get(seeded.ada, mission.id);
    expect(detail?.accounts[0]?.resources.map((r) => r.ref).sort()).toEqual([
      'acme/app',
      'acme/infra',
      'acme/web',
    ]);
  });

  it('reaches nothing on an account that had no resource at issuance, even once discovery finds some', async () => {
    const empty = await seedAccount(root.store, {
      service: 'github',
      owner: { kind: 'user', id: seeded.bob.id },
      displayName: 'empty-org',
      resources: [],
    });
    const { mission, token } = await issued(
      {
        name: 'Nothing to touch yet',
        accounts: [{ account_id: empty.account.id, trust_levels: { read: 'careful' } }],
        period: DAILY,
        expires_at: null,
      },
      seeded.bob,
    );
    expect(flatAccounts(mission)).toEqual([
      {
        accountId: empty.account.id,
        resourceIds: [],
        trustLevels: { read: 'careful' },
      },
    ]);

    await root.store.accounts.syncDiscoveredResources(empty.account.id, [
      { ref: 'acme/later', displayName: 'acme/later' },
    ]);

    // The door: scope `all` with no stored id is "none known at issuance".
    const ctx = await loadMissionContext(
      root.store,
      mission,
      {
        id: 'token',
        prefix: token.prefix,
        holder: { kind: 'named', name: 'test' },
      },
      [],
    );
    expect(ctx.resources).toEqual([]);
    // The page and the kit say what the door enforces.
    const detail = await missions.get(seeded.bob, mission.id);
    expect(detail?.accounts.map((c) => c.resources)).toEqual([[]]);
    expect(detail?.kit?.agent_instructions).not.toContain('acme/later');
    const rotated = await missions.rotate(seeded.bob, mission.id);
    expect(rotated.ok && rotated.kit.agent_instructions).not.toContain('acme/later');
  });

  it('lists no hidden resource in the kit of a mission issued on "all" when every resource is hidden', async () => {
    for (const resource of seeded.github.resources) {
      await root.store.accounts.setResourceHidden(resource.id, true);
    }
    const { mission, kit } = await issued();
    expect(mission.accounts[0]?.resourceSets[0]?.resourceIds).toEqual([]);
    for (const resource of seeded.github.resources) {
      expect(kit.agent_instructions).not.toContain(`\`${resource.ref}\``);
    }
    const detail = await missions.get(seeded.ada, mission.id);
    expect(detail?.accounts[0]?.resources).toEqual([]);
  });

  it('drops a resource that turned stale from the detail and the kit, like the door does', async () => {
    const { mission, token } = await issued();
    agePastStaleGrace(root.store, seeded.github.account.id); // past the grace of a fresh row
    await root.store.accounts.syncDiscoveredResources(seeded.github.account.id, [
      { ref: 'acme/app', displayName: 'acme/app' },
      { ref: 'acme/infra', displayName: 'acme/infra' },
    ]);
    const ctx = await loadMissionContext(
      root.store,
      mission,
      {
        id: 'token',
        prefix: token.prefix,
        holder: { kind: 'named', name: 'test' },
      },
      [],
    );
    const reachable = ctx.resources.map((r) => r.ref).sort();
    expect(reachable).toEqual(['acme/app', 'acme/infra']);
    const detail = await missions.get(seeded.ada, mission.id);
    expect(detail?.accounts[0]?.resources.map((r) => r.ref).sort()).toEqual(reachable);
    expect(detail?.kit?.agent_instructions).not.toContain('`acme/web`');
  });

  it('resolves "all" without hidden and stale resources; a hidden one only when ticked', async () => {
    const accountId = seeded.github.account.id;
    const idOf = (ref: string) => seeded.github.resources.find((r) => r.ref === ref)?.id ?? '';
    await root.store.accounts.setResourceHidden(idOf('acme/infra'), true);
    // Discovery no longer returns acme/web: it turns stale, it is not deleted.
    agePastStaleGrace(root.store, accountId); // past the grace of a fresh row
    await root.store.accounts.syncDiscoveredResources(accountId, [
      { ref: 'acme/app', displayName: 'acme/app' },
      { ref: 'acme/infra', displayName: 'acme/infra' },
    ]);

    const context = await missions.issuanceContext(seeded.ada);
    const github = context.find((c) => c.id === accountId);
    expect(github?.resources.map((r) => [r.ref, r.hidden, r.stale]).sort()).toEqual([
      ['acme/app', false, false],
      ['acme/infra', true, false],
      ['acme/web', false, true],
    ]);

    const all = await issued();
    expect(all.mission.accounts[0]?.resourceSets[0]?.resourceIds).toEqual([idOf('acme/app')]);

    const withHidden = await issued(
      githubDraft({
        name: 'With the hidden one',
        accounts: [
          {
            account_id: accountId,
            trust_levels: DEVELOPER_TRUST_LEVELS,
            resources: { scope: 'selected', resource_refs: ['acme/app', 'acme/infra'] },
          },
        ],
      }),
    );
    expect(
      [...(withHidden.mission.accounts[0]?.resourceSets[0]?.resourceIds ?? [])].sort(),
    ).toEqual([idOf('acme/app'), idOf('acme/infra')].sort());

    const withStale = await missions.issue(
      seeded.ada,
      githubDraft({
        accounts: [
          {
            account_id: accountId,
            trust_levels: DEVELOPER_TRUST_LEVELS,
            resources: { scope: 'selected', resource_refs: ['acme/app', 'acme/web'] },
          },
        ],
      }),
    );
    if (withStale.ok || withStale.reason !== 'refused') throw new Error('expected a refusal');
    expect(withStale.preview.issues.map((i) => i.code)).toEqual(['resource-stale']);
  });

  it('future resources: the whole account is the known list with future on, and a resource found later is written in', async () => {
    const accountId = seeded.github.account.id;
    const before = await issued();
    const { mission, token, kit } = await issued(
      githubDraft({
        name: 'Run the whole account',
        accounts: [
          {
            account_id: accountId,
            trust_levels: DEVELOPER_TRUST_LEVELS,
            resources: { scope: 'account' },
          },
        ],
      }),
    );
    expect(flatAccounts(mission)).toEqual([
      {
        accountId,
        resourceIds: seeded.github.resources.map((r) => r.id).sort(),
        future: true,
        trustLevels: DEVELOPER_TRUST_LEVELS,
      },
    ]);
    expect(kit.agent_instructions).toContain(
      'resources found later in the same environment join it.',
    );
    // The audit of the issuance records the lists and `future`, so the width is on record.
    const issuedEntries = await root.store.audit.list({ kind: 'admin', act: 'mission-issued' });
    expect(
      issuedEntries.map((e) => e.kind === 'admin' && (e.after as { accounts: unknown }).accounts),
    ).toContainEqual([
      {
        account_id: accountId,
        resource_ids: seeded.github.resources.map((r) => r.id).sort(),
        resource_sets: [
          {
            resource_set_id: expect.any(String) as string,
            position: 1,
            future: true,
            env: null,
            resource_ids: seeded.github.resources.map((r) => r.id).sort(),
          },
        ],
      },
    ]);

    // Discovery finds a new repository, the owner hides one, another vanishes.
    const idOf = (ref: string) => seeded.github.resources.find((r) => r.ref === ref)?.id ?? '';
    await root.store.accounts.setResourceHidden(idOf('acme/infra'), true);
    agePastStaleGrace(root.store, accountId); // past the grace of a fresh row
    const snapshot = await root.accounts.futureResources.snapshot(accountId);
    await root.store.accounts.syncDiscoveredResources(accountId, [
      { ref: 'acme/app', displayName: 'acme/app' },
      { ref: 'acme/infra', displayName: 'acme/infra' },
      { ref: 'acme/new', displayName: 'acme/new' },
    ]);
    const moves = await root.accounts.futureResources.settle(accountId, snapshot, seeded.ada.id);
    expect(moves.map((m) => [m.missionId, m.ref, m.change, m.reason])).toEqual([
      [mission.id, 'acme/new', 'joined', 'discovered'],
    ]);

    // The door loads the mission again at every request: the join is in its list.
    const reloaded = await root.store.missions.getById(mission.id);
    const ctx = await loadMissionContext(
      root.store,
      reloaded!,
      { id: 'token', prefix: token.prefix, holder: { kind: 'named', name: 'test' } },
      [],
    );
    // The hidden repository stays: it was in the list. The stale one is not reached.
    expect(ctx.resources.map((r) => r.ref).sort()).toEqual(['acme/app', 'acme/infra', 'acme/new']);
    const detail = await missions.get(seeded.ada, mission.id);
    expect(detail?.accounts[0]?.future).toBe(true);
    expect(detail?.accounts[0]?.resources.map((r) => r.ref).sort()).toEqual([
      'acme/app',
      'acme/infra',
      'acme/new',
    ]);
    expect(detail?.kit?.agent_instructions).toContain('`acme/new`');
    expect(detail?.kit?.agent_instructions).not.toContain('`acme/web`');
    const joined = await root.store.audit.list({ kind: 'admin', act: 'mission-resource-joined' });
    expect(joined.map((e) => e.kind === 'admin' && [e.object.id, e.after])).toEqual([
      [
        mission.id,
        {
          account_id: accountId,
          resource_set_id: mission.accounts[0]?.resourceSets[0]?.id,
          refs: ['acme/new'],
          reason: 'discovered',
        },
      ],
    ]);

    // A mission issued on "every resource known now" is not widened by the same discovery.
    const known = await missions.get(seeded.ada, before.mission.id);
    expect(known?.accounts[0]?.future).toBe(false);
    expect(known?.accounts[0]?.resources.map((r) => r.ref)).not.toContain('acme/new');

    // The owner's page of the account says it; a copy is as wide as its source.
    const onAccount = await missions.onAccount(seeded.ada, accountId);
    expect(onAccount.find((m) => m.id === mission.id)?.future).toBe(true);
    expect(onAccount.find((m) => m.id === before.mission.id)?.future).toBe(false);
    const copy = await missions.duplicate(seeded.ada, mission.id);
    if (!copy.ok) throw new Error('duplicate refused');
    expect(copy.mission.accounts[0]?.resourceSets[0]).toMatchObject({ future: true });
  });

  it('drops a resource that turned stale when duplicating', async () => {
    const source = await issued();
    agePastStaleGrace(root.store, seeded.github.account.id); // past the grace of a fresh row
    await root.store.accounts.syncDiscoveredResources(seeded.github.account.id, [
      { ref: 'acme/app', displayName: 'acme/app' },
    ]);
    const copy = await missions.duplicate(seeded.ada, source.mission.id);
    if (!copy.ok) throw new Error('duplicate refused');
    expect(copy.mission.accounts[0]?.resourceSets[0]?.resourceIds).toHaveLength(1);
    expect(source.mission.accounts[0]?.resourceSets[0]?.resourceIds).toHaveLength(3);
  });

  describe('a token row of another algorithm', () => {
    it('an argon2id row of an earlier build matches nothing (migration 0027 revoked them)', async () => {
      const { token } = await issued();
      root.store.db
        .prepare("UPDATE mission_tokens SET hash = ?, hash_alg = 'argon2id' WHERE prefix = ?")
        .run('$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$aGFzaA', token.prefix);
      expect(await missions.verifyToken(token.secret)).toEqual({ outcome: 'unknown' });
    });

    it('a row naming an algorithm nobody knows matches nothing', async () => {
      const { token } = await issued();
      root.store.db
        .prepare("UPDATE mission_tokens SET hash_alg = 'plain', hash = ? WHERE prefix = ?")
        .run(token.secret, token.prefix);
      expect(await missions.verifyToken(token.secret)).toEqual({ outcome: 'unknown' });
    });
  });

  it('stores the hash and the prefix, never the secret; audits the issuance without it', async () => {
    const { mission, token } = await issued();
    const [row] = await root.store.missions.listTokens(mission.id);
    expect(row).toMatchObject({ prefix: token.prefix, hashAlg: 'sha256', status: 'active' });
    expect(row?.hash).toBe(digestApiKey(token.secret));
    expect(row?.hash).not.toContain(token.secret.slice(-32));

    const audit = await root.store.audit.list({ kind: 'admin' });
    const entry = audit.find((e) => e.kind === 'admin' && e.act === 'mission-issued');
    expect(entry).toMatchObject({
      user_id: seeded.ada.id,
      object: { type: 'mission', id: mission.id },
    });
    // The audit is immutable: its payload is pinned, snake_case domain shapes
    // only, never the store's camelCase record.
    expect(entry?.kind === 'admin' && entry.after).toEqual({
      name: 'Ship the billing page',
      accounts: [
        {
          account_id: seeded.github.account.id,
          resource_ids: seeded.github.resources.map((r) => r.id).sort(),
          resource_sets: [
            {
              resource_set_id: mission.accounts[0]?.resourceSets[0]?.id,
              position: 1,
              future: false,
              env: null,
              resource_ids: seeded.github.resources.map((r) => r.id).sort(),
            },
          ],
        },
      ],
      policy: mission.policy.map((e) => ({
        resource_set_id: e.resourceSetId,
        risk_id: e.riskId,
        quota: e.quota,
        rate_limit: { max: e.rateLimit, window_seconds: e.rateWindowSeconds },
        gate: e.gate,
      })),
      period: { kind: 'recurring', length_seconds: 86_400 },
      expires_at: null,
      token_prefix: token.prefix,
    });
    expect(mission.policy).toHaveLength(
      githubActionRows(Object.keys(DEVELOPER_TRUST_LEVELS)).length,
    );
    expect(JSON.stringify(entry)).not.toMatch(/accountId|resourceScope|resourceIds|riskId/);
    const secretPart = token.secret.slice(-32);
    expect(JSON.stringify(audit)).not.toContain(secretPart);
    const dump = root.store.db
      .prepare<[], { hash: string; prefix: string }>('SELECT hash, prefix FROM mission_tokens')
      .all();
    expect(JSON.stringify(dump)).not.toContain(secretPart);
  });

  it('writes nothing when the draft is refused, and names every reason', async () => {
    const result = await missions.issue(
      seeded.ada,
      githubDraft({
        accounts: [
          {
            account_id: seeded.github.account.id,
            policy: [{ risk_id: 'github.merge-protected' }, { risk_id: 'github.*', quota: 1 }],
          },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok || result.reason !== 'refused') throw new Error('expected a refusal');
    expect(result.preview.issues.map((i) => i.code).sort()).toEqual([
      'missing-budget',
      'unknown-risk',
    ]);
    expect(await root.store.missions.listForCreator(seeded.ada.id)).toEqual([]);
  });

  it('refuses a mission on an account the creator holds no authority on', async () => {
    const result = await missions.issue(seeded.bob, githubDraft());
    if (result.ok || result.reason !== 'refused') throw new Error('expected a refusal');
    expect(result.preview.issues.map((i) => i.code)).toEqual(['account-unknown']);
    expect(await missions.issuanceContext(seeded.bob)).toEqual([]);
  });

  it('lets a member of the owner group issue, and stops when they leave it', async () => {
    const group = await root.store.groups.getOrCreate('github-admins', 'local', null);
    await root.store.groups.addMember(group.id, seeded.bob.id);
    await root.store.accounts.transferOwner(seeded.github.account.id, {
      kind: 'group',
      id: group.id,
    });
    expect((await missions.issue(seeded.bob, githubDraft())).ok).toBe(true);
    await root.store.groups.removeMember(group.id, seeded.bob.id);
    expect((await missions.issue(seeded.bob, githubDraft())).ok).toBe(false);
  });

  it('issues a three-account mission with one partition per account', async () => {
    const result = await issued({
      name: 'Three services',
      accounts: [
        {
          account_id: seeded.github.account.id,
          trust_levels: { read: 'careful' },
          resources: { scope: 'selected', resource_refs: ['acme/app'] },
        },
        {
          account_id: seeded.supabase.account.id,
          trust_levels: SUPABASE_STAGING_TRUST_LEVELS,
        },
        { account_id: seeded.vercel.account.id, trust_levels: VERCEL_DEVELOPER_TRUST_LEVELS },
      ],
      period: DAILY,
      expires_at: null,
    });
    const services = result.mission.policy.map((e) => e.riskId.split(/[.[]/)[0]);
    expect(new Set(services)).toEqual(new Set(['github', 'supabase', 'vercel']));
    // One partition per account: each holds its own service's lines, all of them.
    expect(result.preview.accounts.map((c) => c.passes.length)).toEqual(
      ['github', 'supabase', 'vercel'].map((p) => services.filter((q) => q === p).length),
    );
    for (const [index, service] of ['github', 'supabase', 'vercel'].entries()) {
      const passes = result.preview.accounts[index]?.passes ?? [];
      expect(passes.length, service).toBeGreaterThan(0);
      expect(
        passes.every((e) => e.risk_id.startsWith(service)),
        service,
      ).toBe(true);
    }
    // Careful on Read: the mission's repositories only; the global search is not in it.
    expect(result.preview.accounts[0]?.passes.map((e) => [e.risk_id, e.gate])).toEqual([
      ['github.read-code', 'auto'],
      ['github.read-meta', 'auto'],
    ]);
    // Vercel resources carry no label: the plugin derives the env from the call.
    expect(result.mission.policy.some((e) => e.riskId === 'vercel[preview].deploy')).toBe(true);
    expect(result.kit.agent_instructions).toContain('`acme/app`');
    expect(result.kit.agent_instructions).not.toContain('`acme/web`');
  });

  it('refuses env-qualified entries no selected resource carries, and leaves them out of the trust levels', async () => {
    const prodOnly = { scope: 'selected', resource_refs: ['prdprojectref'] } as const;
    const explicit = await missions.preview(seeded.ada, {
      name: 'Prod only',
      accounts: [
        {
          account_id: seeded.supabase.account.id,
          resources: prodOnly,
          policy: [
            {
              risk_id: 'supabase[staging].bulk-row-write',
              quota: 5,
              rate_limit: { max: 1, window_seconds: 60 },
            },
            {
              risk_id: 'supabase[prod].migration-write',
              quota: 5,
              rate_limit: { max: 1, window_seconds: 60 },
            },
          ],
        },
      ],
      period: DAILY,
      expires_at: null,
    });
    expect(explicit.ok).toBe(false);
    expect(explicit.accounts[0]?.unresolvable).toEqual([
      { risk_id: 'supabase[staging].bulk-row-write', env: 'staging' },
    ]);

    const fromTrustLevels = await missions.preview(seeded.ada, {
      name: 'Prod only',
      accounts: [
        {
          account_id: seeded.supabase.account.id,
          resources: prodOnly,
          trust_levels: SUPABASE_STAGING_TRUST_LEVELS,
        },
      ],
      period: DAILY,
      expires_at: null,
    });
    expect(fromTrustLevels.ok).toBe(true);
    const leftOut = fromTrustLevels.accounts[0]?.left_out ?? [];
    expect(leftOut.length).toBeGreaterThan(0);
    // At Trusting no row is left out: only the environments no project carries.
    expect(leftOut.every((s) => s.reason === 'unresolvable-env' && s.env !== 'prod')).toBe(true);
    expect(leftOut.map((s) => s.risk_id)).toContain('supabase[staging].bulk-row-write');
    expect(fromTrustLevels.policy.every((e) => !e.risk_id.includes('[staging]'))).toBe(true);
    expect(fromTrustLevels.policy.map((e) => e.risk_id)).toContain(
      'supabase[prod].migration-write',
    );
  });

  it('duplicates a mission: same policy, its own token and budget, source untouched', async () => {
    const source = await issued(
      githubDraft({
        accounts: [
          {
            account_id: seeded.github.account.id,
            trust_levels: DEVELOPER_TRUST_LEVELS,
            resources: { scope: 'selected', resource_refs: ['acme/app', 'acme/web'] },
            // Beside a policy the trust levels decide nothing: each line carries its budget.
            policy: [
              { risk_id: 'github.read-code', quota: 7, rate_limit: { max: 5, window_seconds: 60 } },
              { risk_id: 'github.create-pr', quota: 3, rate_limit: { max: 1, window_seconds: 60 } },
            ],
          },
        ],
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    );
    const copy = await missions.duplicate(seeded.ada, source.mission.id);
    if (!copy.ok) throw new Error('duplicate refused');
    expect(copy.mission.id).not.toBe(source.mission.id);
    expect(copy.mission.name).toBe('Ship the billing page (copy)');
    // Same lines, in the copy's own set: the copy counts on its own.
    expect(flatPolicy(copy.mission)).toEqual(flatPolicy(source.mission));
    expect(flatAccounts(copy.mission)).toEqual(flatAccounts(source.mission));
    expect(copy.mission.periodSeconds).toBe(source.mission.periodSeconds);
    expect(copy.mission.expiresAt).toBeNull();
    expect(copy.token.prefix).not.toBe(source.token.prefix);
    expect((await missions.verifyToken(source.token.secret)).outcome).toBe('verified');
    expect((await missions.verifyToken(copy.token.secret)).outcome).toBe('verified');

    const renamed = await missions.duplicate(seeded.ada, source.mission.id, { name: 'Round two' });
    expect(renamed.ok && renamed.mission.name).toBe('Round two');
  });

  it('re-checks the authority when duplicating, and hides other people’s missions', async () => {
    const source = await issued();
    expect(await missions.duplicate(seeded.bob, source.mission.id)).toEqual({
      ok: false,
      reason: 'not-found',
    });
    await root.store.accounts.transferOwner(seeded.github.account.id, {
      kind: 'user',
      id: seeded.bob.id,
    });
    const refused = await missions.duplicate(seeded.ada, source.mission.id);
    if (refused.ok || refused.reason !== 'refused') throw new Error('expected a refusal');
    expect(refused.preview.issues.map((i) => i.code)).toEqual(['account-unknown']);
  });

  it('rotates and revokes only for the creator; revoke is idempotent; a revoked mission cannot rotate', async () => {
    const { mission } = await issued();
    expect(await missions.rotate(seeded.bob, mission.id)).toEqual({
      ok: false,
      reason: 'not-found',
    });
    expect(await missions.revoke(seeded.bob, mission.id)).toEqual({
      ok: false,
      reason: 'not-found',
    });
    expect(await missions.get(seeded.bob, mission.id)).toBeNull();

    expect(await missions.revoke(seeded.ada, mission.id)).toMatchObject({ tokensRevoked: 1 });
    expect(await missions.revoke(seeded.ada, mission.id)).toMatchObject({
      ok: true,
      tokensRevoked: 0,
    });
    expect(await missions.rotate(seeded.ada, mission.id)).toEqual({
      ok: false,
      reason: 'inactive',
      state: 'revoked',
    });
    const acts = (await root.store.audit.list({ kind: 'admin' })).map((e) =>
      e.kind === 'admin' ? e.act : null,
    );
    expect(acts.filter((a) => a === 'mission-revoked')).toHaveLength(1);
  });

  it('records rotation and revocation in the session once it exists', async () => {
    const { mission } = await issued();
    await missions.rotate(seeded.ada, mission.id); // no session yet: nothing to record
    const session = await root.store.sessions.getOrCreate(mission.id);
    await missions.rotate(seeded.ada, mission.id);
    await missions.revoke(seeded.ada, mission.id);
    const events = await root.store.sessions.listEvents(session.id);
    expect(events.map((e) => e.kind)).toEqual(['rotation', 'revocation']);
    expect(events.every((e) => e.actorUserId === seeded.ada.id)).toBe(true);
    const acts = (await root.store.audit.list({ kind: 'admin' })).map((e) =>
      e.kind === 'admin' ? e.act : null,
    );
    expect(acts.filter((a) => a === 'mission-rotated')).toHaveLength(2);
  });

  it('lists the creator’s missions newest first with their state and token prefix', async () => {
    const a = await issued(githubDraft({ name: 'First' }));
    // Issuance no longer takes the tens of milliseconds of a slow hash: let the clock tick.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const b = await issued(githubDraft({ name: 'Second' }));
    await missions.revoke(seeded.ada, a.mission.id);
    const list = await missions.list(seeded.ada);
    expect(list.map((m) => [m.mission.name, m.state.kind, m.token?.prefix ?? null])).toEqual([
      ['Second', 'active', b.token.prefix],
      ['First', 'revoked', null],
    ]);
    expect(await missions.list(seeded.bob)).toEqual([]);
  });

  it('shows the detail with labels, remaining budget and a kit that masks the secret', async () => {
    const { mission, token } = await issued();
    const detail = await missions.get(seeded.ada, mission.id);
    if (!detail) throw new Error('detail missing');
    expect(detail.state.kind).toBe('active');
    expect(detail.policy.every((r) => r.label !== r.risk_id && r.remaining === r.quota)).toBe(true);
    expect(detail.accounts[0]).toMatchObject({ service: 'github', display_name: 'acme-org' });
    expect(detail.kit?.reveals_secret).toBe(false);
    expect(detail.kit?.env).toContain(`vbn_live_${token.prefix}_…`);
    expect(JSON.stringify(detail)).not.toContain(token.secret);
    expect(detail.kit?.endpoint).toBe('https://gateway.example.com/mcp');
  });

  it('refuses a past expiry, expires on read, and refuses to rotate an expired mission', async () => {
    const clock = new ManualClock('2026-10-13T09:00:00.000Z');
    const timed = new MissionService({
      store: root.store,
      registry: root.registry,
      authority: root.missions.authority,
      grounds: root.authority.grounds,
      publicUrl: root.config.publicUrl,
      selfResources: root.config.selfResources,
      clock,
      logger: root.logger,
    });
    const past = await timed.issue(
      seeded.ada,
      githubDraft({ expires_at: '2026-10-13T08:00:00.000Z' }),
    );
    expect(past.ok).toBe(false);
    const soon = await timed.issue(
      seeded.ada,
      githubDraft({ expires_at: '2026-10-13T10:00:00.000Z' }),
    );
    if (!soon.ok) throw new Error('issue refused');
    expect(soon.mission.expiresAt).toBe('2026-10-13T10:00:00.000Z');
    clock.advance(2 * 3_600_000);
    expect((await timed.get(seeded.ada, soon.mission.id))?.state.kind).toBe('expired');
    expect(await timed.rotate(seeded.ada, soon.mission.id)).toEqual({
      ok: false,
      reason: 'inactive',
      state: 'expired',
    });
  });

  it('issues a one-off mission with a single period', async () => {
    const { mission } = await issued(githubDraft({ period: { kind: 'one-off' } }));
    expect(mission.periodSeconds).toBeNull();
    const detail = await missions.get(seeded.ada, mission.id);
    expect(detail?.period).toEqual({ kind: 'one-off' });
    expect(detail?.state.kind === 'active' && detail.state.period.end).toBeNull();
  });

  it('re-draws a token prefix that is already taken', async () => {
    const first = await issued();
    const { mintMissionToken } = await import('../../../src/server/missions');
    let calls = 0;
    const colliding = new MissionService({
      store: root.store,
      registry: root.registry,
      authority: root.missions.authority,
      grounds: root.authority.grounds,
      publicUrl: root.config.publicUrl,
      selfResources: root.config.selfResources,
      clock: new ManualClock(new Date()),
      logger: root.logger,
      mint: async () => {
        calls += 1;
        const minted = await mintMissionToken();
        return calls === 1 ? { ...minted, prefix: first.token.prefix } : minted;
      },
    });
    const second = await colliding.issue(seeded.ada, githubDraft({ name: 'Other' }));
    expect(second.ok && second.token.prefix).not.toBe(first.token.prefix);
    expect(calls).toBe(2);
    expect((await missions.verifyToken(first.token.secret)).outcome).toBe('verified');
  });
});

describe('missions: issuance context', () => {
  let root: GatewayRoot;
  let seeded: SeededInstance;

  beforeEach(async () => {
    root = await buildTestRoot();
    seeded = await seedInstance(root);
  });
  afterEach(async () => {
    await root.close();
  });

  it('carries resources, catalog, authority and macro-actions; flags env-deriving plugins', async () => {
    const context = await root.missions.service.issuanceContext(seeded.ada);
    const byService = new Map(context.map((c) => [c.service, c]));
    expect([...byService.keys()].sort()).toEqual(['github', 'gmail', 'supabase', 'vercel']);
    expect(byService.get('gmail')).not.toHaveProperty('experimental');
    expect(byService.get('vercel')?.derives_env).toBe(true);
    expect(byService.get('supabase')?.derives_env).toBe(false);
    for (const account of context) {
      const registered = root.registry.get(account.service);
      expect(account.macro_actions).toEqual(
        registered ? macroActionsOf(registered.plugin.catalog) : undefined,
      );
      expect(account.macro_actions.length).toBeGreaterThan(0);
      expect(account).not.toHaveProperty('presets');
      expect(account.authority).toEqual(account.risks.map((r) => r.risk_id));
      expect(account.authority.every((id) => !/[*?]/.test(id))).toBe(true);
    }
    expect(
      byService
        .get('supabase')
        ?.resources.map((r) => r.env)
        .sort(),
    ).toEqual(['prod', 'staging']);
  });

  it('leaves out revoked accounts and keeps expired ones visible but unusable', async () => {
    const { service } = root.missions;
    await root.store.accounts.revoke(seeded.vercel.account.id);
    expect(await root.store.accounts.markExpired(seeded.github.account.id)).toBe(true);
    const context = await service.issuanceContext(seeded.ada);
    expect(context.some((c) => c.service === 'vercel')).toBe(false);
    expect(context.find((c) => c.service === 'github')?.status).toBe('expired');
    const preview = await service.preview(seeded.ada, {
      name: 'On an expired account',
      accounts: [{ account_id: seeded.github.account.id, trust_levels: { read: 'careful' } }],
      period: DAILY,
      expires_at: null,
    });
    expect(preview.issues.map((i) => i.code)).toEqual(['account-unavailable']);
  });

  it('leaves an unlabelled resource out of "all", and refuses it picked, on an env-scoped catalog', async () => {
    const { service } = root.missions;
    const owner = { kind: 'user', id: seeded.bob.id } as const;
    const { account } = await seedAccount(root.store, {
      service: 'supabase',
      owner,
      displayName: 'supabase (bob)',
      resources: [{ ref: 'unlabelled' }, { ref: 'stg', env: 'staging' }],
    });
    const preview = await service.preview(seeded.bob, {
      name: 'One project without a label',
      accounts: [{ account_id: account.id, trust_levels: SUPABASE_STAGING_TRUST_LEVELS }],
      period: DAILY,
      expires_at: null,
    });
    // It passes on the labelled one; the creator is told what was left out.
    expect(preview.ok).toBe(true);
    expect(preview.notices.map((n) => [n.code, n.resource_refs, n.account_id])).toEqual([
      ['unlabelled-resources-left-out', ['unlabelled'], account.id],
    ]);
    expect(preview.resolved[0]?.resource_sets.map((set) => set.env)).toEqual(['staging']);
    // Picked by name, it is refused: a resource enters a set only labelled.
    const picked = await service.preview(seeded.bob, {
      name: 'The unlabelled project',
      accounts: [
        {
          account_id: account.id,
          resources: { scope: 'selected', resource_refs: ['unlabelled'] },
          trust_levels: SUPABASE_STAGING_TRUST_LEVELS,
        },
      ],
      period: DAILY,
      expires_at: null,
    });
    expect(picked.issues.map((i) => i.code)).toContain('resource-unlabelled');

    // Vercel derives the environment from the call: nothing to say.
    const vercel = await root.missions.service.preview(seeded.ada, {
      name: 'Vercel',
      accounts: [
        { account_id: seeded.vercel.account.id, trust_levels: VERCEL_DEVELOPER_TRUST_LEVELS },
      ],
      period: DAILY,
      expires_at: null,
    });
    expect(vercel.notices.filter((n) => n.code !== 'split-by-environment')).toEqual([]);
  });

  it("reads unlabelled resources under the account's default environment at issuance", async () => {
    const { service } = root.missions;
    const owner = { kind: 'user', id: seeded.bob.id } as const;
    const { account } = await seedAccount(root.store, {
      service: 'supabase',
      owner,
      displayName: 'supabase staging org (bob)',
      resources: [
        { ref: 'created-yesterday' },
        { ref: 'created-today' },
        { ref: 'p', env: 'prod' },
      ],
    });
    const draft = {
      name: 'On new projects',
      accounts: [
        {
          account_id: account.id,
          resources: {
            scope: 'selected' as const,
            resource_refs: ['created-yesterday', 'created-today'],
          },
          trust_levels: SUPABASE_STAGING_TRUST_LEVELS,
        },
      ],
      period: DAILY,
      expires_at: null,
    };
    const unlabelled = await service.preview(seeded.bob, draft);
    expect(unlabelled.issues.map((n) => n.code)).toEqual(['resource-unlabelled']);
    expect(unlabelled.issues[0]?.message).toContain('default environment');

    await root.store.accounts.setDefaultEnv(account.id, 'staging');
    const context = await service.issuanceContext(seeded.bob);
    const issuance = context.find((c) => c.id === account.id);
    expect(issuance?.default_env).toBe('staging');
    expect(issuance?.resources.map((r) => [r.ref, r.env])).toEqual([
      ['created-today', 'staging'],
      ['created-yesterday', 'staging'],
      ['p', 'prod'],
    ]);
    const preview = await service.preview(seeded.bob, draft);
    expect(preview.ok).toBe(true);
    expect(preview.notices).toEqual([]);
    expect(preview.issues).toEqual([]);
    const issued = await service.issue(seeded.bob, draft);
    expect(issued.ok).toBe(true);
  });

  it('issues every macro-action of every registered plugin at every trust level cleanly for an owner with labelled resources', async () => {
    const { service: missions } = root.missions;
    const owner = { kind: 'user', id: seeded.bob.id } as const;
    let composed = 0;
    for (const service of root.registry.ids) {
      const envs = catalogEnvs(root.registry, service);
      const { account } = await seedAccount(root.store, {
        service,
        owner,
        displayName: `${service} (bob)`,
        resources: [{ ref: 'unlabelled' }, ...envs.map((env) => ({ ref: `res-${env}`, env }))],
      });
      const issuance = (await missions.issuanceContext(seeded.bob)).find(
        (c) => c.id === account.id,
      );
      const known = new Set(issuance?.risks.map((r) => r.risk_id));
      for (const action of issuance?.macro_actions ?? []) {
        for (const trustLevel of TRUST_LEVELS) {
          const where = `${service}/${action.id}@${trustLevel}`;
          const preview = await missions.preview(seeded.bob, {
            name: where,
            accounts: [{ account_id: account.id, trust_levels: { [action.id]: trustLevel } }],
            period: DAILY,
            expires_at: null,
          });
          const leftOut = preview.accounts[0]?.left_out ?? [];
          // The owner holds the whole catalog and every environment is labelled: one set
          // per environment, and only the trust level itself leaves a risk out of a set —
          // besides the risks of the other environments.
          for (const set of preview.accounts[0]?.resource_sets ?? []) {
            expect(
              set.left_out.every(
                (s) =>
                  s.reason === 'trust-level' ||
                  (s.reason === 'unresolvable-env' && s.env !== set.env),
              ),
              where,
            ).toBe(true);
          }
          if (preview.policy.length === 0) {
            // Said by each set of the account (one per environment).
            expect([...new Set(preview.issues.map((i) => i.code))], where).toEqual([
              'no-accepted-risk',
            ]);
            continue;
          }
          expect(preview.issues, where).toEqual([]);
          expect(
            preview.policy.every((e) => known.has(e.risk_id)),
            where,
          ).toBe(true);
          // Explicit ids pass as they are; an env-scoped entry becomes one line per environment.
          const written = new Set(preview.policy.map((e) => unqualifyRiskId(e.risk_id)));
          const dropped = new Set(leftOut.map((e) => unqualifyRiskId(e.risk_id)));
          for (const entry of action.entries) {
            expect(written.has(entry.risk_id) || dropped.has(entry.risk_id), where).toBe(true);
          }
          expect(
            [...written].every((id) => action.entries.some((e) => e.risk_id === id)),
            where,
          ).toBe(true);
          // The fallback is only ever written by "Anything else".
          expect(
            preview.policy.some((e) => e.risk_id.includes('uncategorized')),
            where,
          ).toBe(action.id === 'anything-else');
          composed += 1;
        }
      }
    }
    expect(composed).toBeGreaterThanOrEqual(root.registry.size);
  });

  it('issues "Everything I hold" on every registered plugin: the explicit list of the authority, within every ceiling', async () => {
    const { service: missions } = root.missions;
    const owner = { kind: 'user', id: seeded.bob.id } as const;
    for (const service of root.registry.ids) {
      const registered = root.registry.get(service);
      expect(
        registered ? macroActionsOf(registered.plugin.catalog).map((a) => a.id) : [],
        `${service} must not ship the built-in id`,
      ).not.toContain('everything-i-hold');
      const envs = catalogEnvs(root.registry, service);
      const { account } = await seedAccount(root.store, {
        service,
        owner,
        displayName: `${service} (everything)`,
        resources: [{ ref: 'unlabelled' }, ...envs.map((env) => ({ ref: `res-${env}`, env }))],
      });
      const draft = {
        name: `${service} wide`,
        accounts: [{ account_id: account.id, everything_i_hold: true }],
        period: DAILY,
        expires_at: null,
      };
      const preview = await missions.preview(seeded.bob, draft);
      expect(preview.issues, service).toEqual([]);
      const issuance = (await missions.issuanceContext(seeded.bob)).find(
        (c) => c.id === account.id,
      );
      // Every non-deprecated id of the owner's authority: every env is labelled here.
      const expected = (issuance?.risks ?? [])
        .filter((r) => !r.deprecated && issuance?.authority.includes(r.risk_id))
        .map((r) => r.risk_id);
      // One set per environment: a risk of several sets is listed once here.
      expect([...new Set(preview.policy.map((e) => e.risk_id))].sort(), service).toEqual(
        [...expected].sort(),
      );
      const fallback = issuance?.risks.filter((r) => r.fallback).map((r) => r.risk_id) ?? [];
      // One notice per set: the fallback of each environment in the notice of its set.
      const noticed = preview.notices
        .filter((n) => n.code === 'everything-i-hold-expanded')
        .flatMap((n) => n.risk_ids);
      for (const id of fallback) expect(noticed, service).toContain(id);
      const issued = await missions.issue(seeded.bob, draft);
      expect(issued.ok, service).toBe(true);
      if (!issued.ok) continue;
      expect(JSON.stringify(issued.mission)).not.toContain('everything');
    }
  });
});
