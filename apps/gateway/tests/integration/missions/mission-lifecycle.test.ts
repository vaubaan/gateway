/**
 * Missions end to end inside the process (spec §10 "integration on an
 * ephemeral instance"): the composition root on the `:memory:` store, real
 * plugin catalogs and presets, connections and resources seeded through the
 * repositories. Issue → the token verifies → rotate → the old token is
 * refused → revoke → `mission-inactive`.
 */
import { checkMissionActive } from '@vaubaan/gateway-core';
import { unqualifyRiskId } from '@vaubaan/policy-engine';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { GatewayRoot } from '../../../src/server/compose/root';
import { loadMissionContext } from '../../../src/server/execution/mission-context';
import { MissionService, type MissionDraft } from '../../../src/server/missions';
import { catalogEnvs, seedConnection } from '../../../src/server/missions/testing';
import { ManualClock } from '../../../src/server/store/clock';
import { buildTestRoot, seedInstance, type SeededInstance } from './support';

const DAILY = { kind: 'recurring', length_seconds: 86_400 } as const;

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
      connections: [{ connection_id: seeded.github.connection.id, preset: 'developer' }],
      period: DAILY,
      expires_at: null,
      ...overrides,
    };
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
    // The door gets the token's id and prefix, never the stored hash.
    expect(Object.keys(verified.token).sort()).toEqual(['id', 'prefix']);
    expect(verified.token.prefix).toBe(first.token.prefix);
    const ctx = await loadMissionContext(root.store, verified.mission, verified.token);
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
      await loadMissionContext(root.store, after.mission, after.token),
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
    expect(mission.connections).toEqual([
      {
        connectionId: seeded.github.connection.id,
        resourceScope: 'selected',
        resourceIds: seeded.github.resources.map((r) => r.id).sort(),
      },
    ]);
    const developer = root.registry.presetsOf('github').find((p) => p.id === 'developer');
    expect(mission.policy.map((e) => e.riskId).sort()).toEqual(
      developer?.entries.map((e) => e.risk_id).sort(),
    );
    expect(mission.policy.every((e) => e.quota >= 1 && e.rateLimit >= 1)).toBe(true);
    expect(preview.connections[0]?.skipped_from_preset).toEqual([]);
    expect(JSON.stringify(mission)).not.toContain('developer');
  });

  it('does not cover a resource discovered after issuance', async () => {
    const { mission } = await issued();
    await root.store.connections.syncDiscoveredResources(seeded.github.connection.id, [
      ...seeded.github.resources.map((r) => ({ ref: r.ref, displayName: r.displayName })),
      { ref: 'acme/new-repo', displayName: 'acme/new-repo' },
    ]);
    const reread = await root.store.missions.getById(mission.id);
    expect(reread?.connections[0]?.resourceIds).toHaveLength(3);
    const detail = await missions.get(seeded.ada, mission.id);
    expect(detail?.connections[0]?.resources.map((r) => r.ref).sort()).toEqual([
      'acme/app',
      'acme/infra',
      'acme/web',
    ]);
  });

  it('reaches nothing on a connection that had no resource at issuance, even once discovery finds some', async () => {
    const empty = await seedConnection(root.store, {
      provider: 'github',
      owner: { kind: 'user', id: seeded.bob.id },
      displayName: 'empty-org',
      resources: [],
    });
    const { mission, token } = await issued(
      {
        name: 'Nothing to touch yet',
        connections: [{ connection_id: empty.connection.id, preset: 'read-only' }],
        period: DAILY,
        expires_at: null,
      },
      seeded.bob,
    );
    expect(mission.connections).toEqual([
      { connectionId: empty.connection.id, resourceScope: 'all', resourceIds: [] },
    ]);

    await root.store.connections.syncDiscoveredResources(empty.connection.id, [
      { ref: 'acme/later', displayName: 'acme/later' },
    ]);

    // The door: scope `all` with no stored id is "none known at issuance".
    const ctx = await loadMissionContext(root.store, mission, {
      id: 'token',
      prefix: token.prefix,
    });
    expect(ctx.resources).toEqual([]);
    // The page and the kit say what the door enforces.
    const detail = await missions.get(seeded.bob, mission.id);
    expect(detail?.connections.map((c) => c.resources)).toEqual([[]]);
    expect(detail?.kit?.agent_instructions).not.toContain('acme/later');
    const rotated = await missions.rotate(seeded.bob, mission.id);
    expect(rotated.ok && rotated.kit.agent_instructions).not.toContain('acme/later');
  });

  it('lists no hidden resource in the kit of a mission issued on "all" when every resource is hidden', async () => {
    for (const resource of seeded.github.resources) {
      await root.store.connections.setResourceHidden(resource.id, true);
    }
    const { mission, kit } = await issued();
    expect(mission.connections[0]?.resourceIds).toEqual([]);
    for (const resource of seeded.github.resources) {
      expect(kit.agent_instructions).not.toContain(`\`${resource.ref}\``);
    }
    const detail = await missions.get(seeded.ada, mission.id);
    expect(detail?.connections[0]?.resources).toEqual([]);
  });

  it('drops a resource that turned stale from the detail and the kit, like the door does', async () => {
    const { mission, token } = await issued();
    await root.store.connections.syncDiscoveredResources(seeded.github.connection.id, [
      { ref: 'acme/app', displayName: 'acme/app' },
      { ref: 'acme/infra', displayName: 'acme/infra' },
    ]);
    const ctx = await loadMissionContext(root.store, mission, {
      id: 'token',
      prefix: token.prefix,
    });
    const reachable = ctx.resources.map((r) => r.ref).sort();
    expect(reachable).toEqual(['acme/app', 'acme/infra']);
    const detail = await missions.get(seeded.ada, mission.id);
    expect(detail?.connections[0]?.resources.map((r) => r.ref).sort()).toEqual(reachable);
    expect(detail?.kit?.agent_instructions).not.toContain('`acme/web`');
  });

  it('resolves "all" without hidden and stale resources; a hidden one only when ticked', async () => {
    const connectionId = seeded.github.connection.id;
    const idOf = (ref: string) => seeded.github.resources.find((r) => r.ref === ref)?.id ?? '';
    await root.store.connections.setResourceHidden(idOf('acme/infra'), true);
    // Discovery no longer returns acme/web: it turns stale, it is not deleted.
    await root.store.connections.syncDiscoveredResources(connectionId, [
      { ref: 'acme/app', displayName: 'acme/app' },
      { ref: 'acme/infra', displayName: 'acme/infra' },
    ]);

    const context = await missions.issuanceContext(seeded.ada);
    const github = context.find((c) => c.id === connectionId);
    expect(github?.resources.map((r) => [r.ref, r.hidden, r.stale]).sort()).toEqual([
      ['acme/app', false, false],
      ['acme/infra', true, false],
      ['acme/web', false, true],
    ]);

    const all = await issued();
    expect(all.mission.connections[0]?.resourceIds).toEqual([idOf('acme/app')]);

    const withHidden = await issued(
      githubDraft({
        name: 'With the hidden one',
        connections: [
          {
            connection_id: connectionId,
            preset: 'developer',
            resources: { scope: 'selected', resource_refs: ['acme/app', 'acme/infra'] },
          },
        ],
      }),
    );
    expect([...(withHidden.mission.connections[0]?.resourceIds ?? [])].sort()).toEqual(
      [idOf('acme/app'), idOf('acme/infra')].sort(),
    );

    const withStale = await missions.issue(
      seeded.ada,
      githubDraft({
        connections: [
          {
            connection_id: connectionId,
            preset: 'developer',
            resources: { scope: 'selected', resource_refs: ['acme/app', 'acme/web'] },
          },
        ],
      }),
    );
    if (withStale.ok || withStale.reason !== 'refused') throw new Error('expected a refusal');
    expect(withStale.preview.issues.map((i) => i.code)).toEqual(['resource-stale']);
  });

  it('drops a resource that turned stale when duplicating', async () => {
    const source = await issued();
    await root.store.connections.syncDiscoveredResources(seeded.github.connection.id, [
      { ref: 'acme/app', displayName: 'acme/app' },
    ]);
    const copy = await missions.duplicate(seeded.ada, source.mission.id);
    if (!copy.ok) throw new Error('duplicate refused');
    expect(copy.mission.connections[0]?.resourceIds).toHaveLength(1);
    expect(source.mission.connections[0]?.resourceIds).toHaveLength(3);
  });

  it('stores the hash and the prefix, never the secret; audits the issuance without it', async () => {
    const { mission, token } = await issued();
    const [row] = await root.store.missions.listTokens(mission.id);
    expect(row).toMatchObject({ prefix: token.prefix, hashAlg: 'argon2id', status: 'active' });
    expect(row?.hash.startsWith('$argon2id$')).toBe(true);

    const audit = await root.store.audit.list({ kind: 'admin' });
    const entry = audit.find((e) => e.kind === 'admin' && e.act === 'mission-issued');
    expect(entry).toMatchObject({
      user_id: seeded.ada.id,
      object: { type: 'mission', id: mission.id },
    });
    // The audit is immutable: its payload is pinned, snake_case domain shapes
    // only, never the store's camelCase record.
    const developer = root.registry.presetsOf('github').find((p) => p.id === 'developer');
    expect(entry?.kind === 'admin' && entry.after).toEqual({
      name: 'Ship the billing page',
      connections: [
        {
          connection_id: seeded.github.connection.id,
          resource_ids: seeded.github.resources.map((r) => r.id).sort(),
        },
      ],
      policy: mission.policy.map((e) => ({
        risk_id: e.riskId,
        quota: e.quota,
        rate_limit: { max: e.rateLimit, window_seconds: e.rateWindowSeconds },
        gate: e.gate,
      })),
      period: { kind: 'recurring', length_seconds: 86_400 },
      expires_at: null,
      token_prefix: token.prefix,
    });
    expect(mission.policy).toHaveLength(developer?.entries.length ?? -1);
    expect(JSON.stringify(entry)).not.toMatch(/connectionId|resourceScope|resourceIds|riskId/);
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
        connections: [
          {
            connection_id: seeded.github.connection.id,
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

  it('refuses a mission on a connection the creator holds no authority on', async () => {
    const result = await missions.issue(seeded.bob, githubDraft());
    if (result.ok || result.reason !== 'refused') throw new Error('expected a refusal');
    expect(result.preview.issues.map((i) => i.code)).toEqual(['connection-unknown']);
    expect(await missions.issuanceContext(seeded.bob)).toEqual([]);
  });

  it('lets a member of the owner group issue, and stops when they leave it', async () => {
    const group = await root.store.groups.getOrCreate('github-admins', 'local');
    await root.store.groups.addMember(group.id, seeded.bob.id);
    await root.store.connections.transferOwner(seeded.github.connection.id, {
      kind: 'group',
      id: group.id,
    });
    expect((await missions.issue(seeded.bob, githubDraft())).ok).toBe(true);
    await root.store.groups.removeMember(group.id, seeded.bob.id);
    expect((await missions.issue(seeded.bob, githubDraft())).ok).toBe(false);
  });

  it('issues a three-connection mission with one partition per connection', async () => {
    const result = await issued({
      name: 'Three providers',
      connections: [
        {
          connection_id: seeded.github.connection.id,
          preset: 'read-only',
          resources: { scope: 'selected', resource_refs: ['acme/app'] },
        },
        { connection_id: seeded.supabase.connection.id, preset: 'staging-developer' },
        { connection_id: seeded.vercel.connection.id, preset: 'developer' },
      ],
      period: DAILY,
      expires_at: null,
    });
    const providers = result.mission.policy.map((e) => e.riskId.split(/[.[]/)[0]);
    expect(new Set(providers)).toEqual(new Set(['github', 'supabase', 'vercel']));
    expect(result.preview.connections.map((c) => c.passes.length)).toEqual([
      root.registry.presetsOf('github').find((p) => p.id === 'read-only')?.entries.length,
      root.registry.presetsOf('supabase').find((p) => p.id === 'staging-developer')?.entries.length,
      root.registry.presetsOf('vercel').find((p) => p.id === 'developer')?.entries.length,
    ]);
    // Vercel resources carry no label: the plugin derives the env from the call.
    expect(result.mission.policy.some((e) => e.riskId === 'vercel[preview].deploy')).toBe(true);
    expect(result.kit.agent_instructions).toContain('`acme/app`');
    expect(result.kit.agent_instructions).not.toContain('`acme/web`');
  });

  it('refuses env-qualified entries no selected resource carries, and skips them from a preset', async () => {
    const prodOnly = { scope: 'selected', resource_refs: ['prdprojectref'] } as const;
    const explicit = await missions.preview(seeded.ada, {
      name: 'Prod only',
      connections: [
        {
          connection_id: seeded.supabase.connection.id,
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
    expect(explicit.connections[0]?.unresolvable).toEqual([
      { risk_id: 'supabase[staging].bulk-row-write', env: 'staging' },
    ]);

    const fromPreset = await missions.preview(seeded.ada, {
      name: 'Prod only',
      connections: [
        {
          connection_id: seeded.supabase.connection.id,
          resources: prodOnly,
          preset: 'staging-developer',
        },
      ],
      period: DAILY,
      expires_at: null,
    });
    expect(fromPreset.ok).toBe(true);
    expect(fromPreset.connections[0]?.skipped_from_preset.length).toBeGreaterThan(0);
    expect(
      fromPreset.connections[0]?.skipped_from_preset.every((s) => s.reason === 'unresolvable-env'),
    ).toBe(true);
    expect(fromPreset.policy.every((e) => !e.risk_id.includes('[staging]'))).toBe(true);
  });

  it('duplicates a mission: same policy, its own token and budget, source untouched', async () => {
    const source = await issued(
      githubDraft({
        connections: [
          {
            connection_id: seeded.github.connection.id,
            preset: 'developer',
            resources: { scope: 'selected', resource_refs: ['acme/app', 'acme/web'] },
            policy: [{ risk_id: 'github.read-code', quota: 7 }, { risk_id: 'github.create-pr' }],
          },
        ],
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    );
    const copy = await missions.duplicate(seeded.ada, source.mission.id);
    if (!copy.ok) throw new Error('duplicate refused');
    expect(copy.mission.id).not.toBe(source.mission.id);
    expect(copy.mission.name).toBe('Ship the billing page (copy)');
    expect(copy.mission.policy).toEqual(source.mission.policy);
    expect(copy.mission.connections).toEqual(source.mission.connections);
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
    await root.store.connections.transferOwner(seeded.github.connection.id, {
      kind: 'user',
      id: seeded.bob.id,
    });
    const refused = await missions.duplicate(seeded.ada, source.mission.id);
    if (refused.ok || refused.reason !== 'refused') throw new Error('expected a refusal');
    expect(refused.preview.issues.map((i) => i.code)).toEqual(['connection-unknown']);
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
    expect(detail.connections[0]).toMatchObject({ provider: 'github', display_name: 'acme-org' });
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
      publicUrl: root.config.publicUrl,
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
      publicUrl: root.config.publicUrl,
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

  it('carries resources, catalog, authority and presets; flags experimental and env-deriving plugins', async () => {
    const context = await root.missions.service.issuanceContext(seeded.ada);
    const byProvider = new Map(context.map((c) => [c.provider, c]));
    expect([...byProvider.keys()].sort()).toEqual(['github', 'gmail', 'supabase', 'vercel']);
    expect(byProvider.get('gmail')?.experimental).toBe(true);
    expect(byProvider.get('github')?.experimental).toBe(false);
    expect(byProvider.get('vercel')?.derives_env).toBe(true);
    expect(byProvider.get('supabase')?.derives_env).toBe(false);
    for (const connection of context) {
      expect(connection.presets).toEqual(root.registry.presetsOf(connection.provider));
      expect(connection.presets.length).toBeGreaterThan(0);
      expect(connection.authority).toEqual(connection.risks.map((r) => r.risk_id));
      expect(connection.authority.every((id) => !/[*?]/.test(id))).toBe(true);
    }
    expect(
      byProvider
        .get('supabase')
        ?.resources.map((r) => r.env)
        .sort(),
    ).toEqual(['prod', 'staging']);
  });

  it('leaves out revoked connections and keeps expired ones visible but unusable', async () => {
    const { service } = root.missions;
    await root.store.connections.revoke(seeded.vercel.connection.id);
    expect(await root.store.connections.markExpired(seeded.github.connection.id)).toBe(true);
    const context = await service.issuanceContext(seeded.ada);
    expect(context.some((c) => c.provider === 'vercel')).toBe(false);
    expect(context.find((c) => c.provider === 'github')?.status).toBe('expired');
    const preview = await service.preview(seeded.ada, {
      name: 'On an expired connection',
      connections: [{ connection_id: seeded.github.connection.id, preset: 'read-only' }],
      period: DAILY,
      expires_at: null,
    });
    expect(preview.issues.map((i) => i.code)).toEqual(['connection-unavailable']);
  });

  it('tells the creator when a selected resource carries no environment label on an env-scoped catalog', async () => {
    const { service } = root.missions;
    const owner = { kind: 'user', id: seeded.bob.id } as const;
    const { connection } = await seedConnection(root.store, {
      provider: 'supabase',
      owner,
      displayName: 'supabase (bob)',
      resources: [{ ref: 'unlabelled' }, { ref: 'stg', env: 'staging' }],
    });
    const preview = await service.preview(seeded.bob, {
      name: 'One project without a label',
      connections: [{ connection_id: connection.id, preset: 'staging-developer' }],
      period: DAILY,
      expires_at: null,
    });
    // It passes: the label is not required, the creator is told what it costs.
    expect(preview.ok).toBe(true);
    expect(preview.notices.map((n) => [n.code, n.resource_refs, n.connection_id])).toEqual([
      ['resource-without-env', ['unlabelled'], connection.id],
    ]);
    expect(preview.notices[0]?.risk_ids.length).toBeGreaterThan(0);
    expect(preview.notices[0]?.risk_ids.every((id) => id.includes('[staging]'))).toBe(true);
    expect(preview.notices[0]?.message).toContain('risk-not-accepted');

    // Vercel derives the environment from the call: nothing to say.
    const vercel = await root.missions.service.preview(seeded.ada, {
      name: 'Vercel',
      connections: [{ connection_id: seeded.vercel.connection.id, preset: 'developer' }],
      period: DAILY,
      expires_at: null,
    });
    expect(vercel.notices).toEqual([]);
  });

  it('issues every preset of every registered plugin cleanly for an owner with labelled resources', async () => {
    const { service } = root.missions;
    const owner = { kind: 'user', id: seeded.bob.id } as const;
    let presets = 0;
    for (const provider of root.registry.ids) {
      const envs = catalogEnvs(root.registry, provider);
      const { connection } = await seedConnection(root.store, {
        provider,
        owner,
        displayName: `${provider} (bob)`,
        resources: [{ ref: 'unlabelled' }, ...envs.map((env) => ({ ref: `res-${env}`, env }))],
      });
      for (const preset of root.registry.presetsOf(provider)) {
        const preview = await service.preview(seeded.bob, {
          name: `${provider} ${preset.id}`,
          connections: [{ connection_id: connection.id, preset: preset.id }],
          period: DAILY,
          expires_at: null,
        });
        expect(preview.issues, `${provider}/${preset.id}`).toEqual([]);
        expect(preview.connections[0]?.skipped_from_preset, `${provider}/${preset.id}`).toEqual([]);
        // Explicit ids pass as they are; a base id of an env-scoped risk
        // (stripe's `read-only`) becomes one entry per labelled environment.
        const known = new Set(
          (await service.issuanceContext(seeded.bob))
            .find((c) => c.id === connection.id)
            ?.risks.map((r) => r.risk_id),
        );
        expect(preview.policy.every((e) => known.has(e.risk_id))).toBe(true);
        expect(new Set(preview.policy.map((e) => unqualifyRiskId(e.risk_id)))).toEqual(
          new Set(preset.entries.map((e) => unqualifyRiskId(e.risk_id))),
        );
        // The fallback is never pre-accepted by a preset.
        expect(preview.policy.some((e) => e.risk_id.includes('uncategorized'))).toBe(false);
        presets += 1;
      }
    }
    expect(presets).toBeGreaterThanOrEqual(root.registry.size);
  });
});
