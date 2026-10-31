import { describe, expect, it } from 'vitest';

import type {
  DraftConnection,
  IssuanceConnection,
  MissionDraft,
  PreviewIssueCode,
  ResolvedDraftConnection,
} from './model';
import { budgetProblem, envNotices, previewConnection, previewDraft, uncoveredOf } from './preview';
import { ACME_HIDDEN, ACME_RESOURCES, ACME_STALE, acmeConnection } from './testing';

/** The explicit ids a resolved line carries; `undefined` for a whole-connection line. */
function idsOf(line: ResolvedDraftConnection | undefined): readonly string[] | undefined {
  return line?.resources.scope === 'selected' ? line.resources.resource_ids : undefined;
}

const NOW = new Date('2026-10-13T09:00:00.000Z');
const BUDGET = { quota: 10, rate_limit: { max: 5, window_seconds: 60 } } as const;

function draftOf(
  connections: readonly DraftConnection[],
  overrides: Partial<MissionDraft> = {},
): MissionDraft {
  return {
    name: 'Ship the billing page',
    connections,
    period: { kind: 'recurring', length_seconds: 86_400 },
    expires_at: null,
    ...overrides,
  };
}

function preview(
  connections: readonly DraftConnection[],
  context: readonly IssuanceConnection[] = [acmeConnection()],
  overrides: Partial<MissionDraft> = {},
) {
  return previewDraft({ connections: context, now: NOW }, draftOf(connections, overrides));
}

function codes(p: { issues: readonly { code: PreviewIssueCode }[] }): PreviewIssueCode[] {
  return p.issues.map((i) => i.code);
}

describe('previewDraft — authority (monotonicity)', () => {
  it('passes a draft whose accepted risks are inside the authority', () => {
    const p = preview([
      { connection_id: 'conn-acme', policy: [{ risk_id: 'acme.read', ...BUDGET }] },
    ]);
    expect(p.ok).toBe(true);
    expect(p.policy).toEqual([{ risk_id: 'acme.read', ...BUDGET, gate: 'auto' }]);
  });

  it('refuses accepted ⊄ authority with the explicit uncovered list', () => {
    const restricted = acmeConnection({ authority: ['acme.read', 'acme[staging].write'] });
    const p = preview(
      [
        {
          connection_id: 'conn-acme',
          policy: [
            { risk_id: 'acme.read', ...BUDGET },
            { risk_id: 'acme.admin', ...BUDGET },
            { risk_id: 'acme[prod].write', ...BUDGET },
          ],
        },
      ],
      [restricted],
    );
    expect(p.ok).toBe(false);
    expect(codes(p)).toEqual(['exceeds-authority']);
    expect(p.issues[0]?.risk_ids).toEqual(['acme.admin', 'acme[prod].write']);
    expect(uncoveredOf(p)).toEqual(['acme.admin', 'acme[prod].write']);
    // What is covered still shows as passing, so the creator sees both halves.
    expect(p.connections[0]?.passes.map((e) => e.risk_id)).toEqual(['acme.read']);
  });

  it('refuses a wildcard, a sentinel and an id of another catalog as unknown risks', () => {
    const p = preview([
      {
        connection_id: 'conn-acme',
        policy: [
          { risk_id: 'acme.*', ...BUDGET },
          { risk_id: '*', ...BUDGET },
          { risk_id: 'github.code-read', ...BUDGET },
          { risk_id: 'acme[dev].write', ...BUDGET },
        ],
      },
    ]);
    expect(codes(p)).toContain('unknown-risk');
    expect(p.connections[0]?.unknown).toEqual([
      'acme.*',
      '*',
      'github.code-read',
      'acme[dev].write',
    ]);
    expect(p.policy).toEqual([]);
  });

  it('answers the same for a connection that does not exist and one the creator holds nothing on', () => {
    const p = preview([
      { connection_id: 'conn-of-someone-else', trust_levels: { read: 'prudent' } },
    ]);
    expect(codes(p)).toEqual(['connection-unknown']);
    expect(p.connections).toEqual([]);
  });

  it('refuses a connection that is not active', () => {
    const p = preview(
      [{ connection_id: 'conn-acme', trust_levels: { read: 'prudent' } }],
      [acmeConnection({ status: 'expired' })],
    );
    expect(codes(p)).toEqual(['connection-unavailable']);
  });
});

describe('previewDraft — partition per connection', () => {
  const beta = acmeConnection({
    id: 'conn-beta',
    provider: 'beta',
    provider_label: 'Beta',
    display_name: 'Beta main',
    resources: [],
    risks: [
      {
        risk_id: 'beta.read',
        base_id: 'beta.read',
        env: null,
        label: 'Read beta',
        reason: 'r',
        vector: {
          reversibility: 'reversible',
          blast: 'single',
          data: 'data',
          cost: 'free',
          visibility: 'internal',
          persistence: 'stateless',
        },
        kind: 'read',
        severity: 1,
        level: 'low',
        fallback: false,
        deprecated: false,
        rate_ceiling_per_minute: null,
      },
    ],
    authority: [],
    write_token_risks: [],
  });

  it('checks each partition against the authority on its own connection', () => {
    const p = preview(
      [
        { connection_id: 'conn-acme', policy: [{ risk_id: 'acme.read', ...BUDGET }] },
        { connection_id: 'conn-beta', policy: [{ risk_id: 'beta.read', ...BUDGET }] },
      ],
      [acmeConnection(), beta],
    );
    expect(codes(p)).toEqual(['exceeds-authority']);
    expect(p.issues[0]).toMatchObject({ connection_id: 'conn-beta', risk_ids: ['beta.read'] });
    expect(p.connections[0]?.exceeds).toEqual([]);
    expect(p.connections[1]?.exceeds).toEqual(['beta.read']);
  });

  it('refuses a risk filed under the wrong connection', () => {
    const p = preview(
      [
        {
          connection_id: 'conn-acme',
          policy: [
            { risk_id: 'acme.read', ...BUDGET },
            { risk_id: 'beta.read', ...BUDGET },
          ],
        },
      ],
      [acmeConnection(), { ...beta, authority: ['beta.read'] }],
    );
    expect(codes(p)).toEqual(['unknown-risk']);
    expect(p.issues[0]?.risk_ids).toEqual(['beta.read']);
  });

  it('yields one flat policy out of the partitions', () => {
    const p = preview(
      [
        { connection_id: 'conn-acme', policy: [{ risk_id: 'acme.read', ...BUDGET }] },
        { connection_id: 'conn-beta', policy: [{ risk_id: 'beta.read', ...BUDGET }] },
      ],
      [acmeConnection(), { ...beta, authority: ['beta.read'] }],
    );
    expect(p.ok).toBe(true);
    expect(p.policy.map((e) => e.risk_id)).toEqual(['acme.read', 'beta.read']);
    expect(p.resolved.map((c) => c.connection_id)).toEqual(['conn-acme', 'conn-beta']);
  });

  it('refuses the same connection twice and two connections of one provider', () => {
    const second = acmeConnection({ id: 'conn-acme-2', display_name: 'Acme second' });
    const twice = preview([
      { connection_id: 'conn-acme', trust_levels: { read: 'prudent' } },
      { connection_id: 'conn-acme', trust_levels: { read: 'prudent' } },
    ]);
    expect(codes(twice)).toEqual(['duplicate-connection']);
    const sameProvider = preview(
      [
        { connection_id: 'conn-acme', trust_levels: { read: 'prudent' } },
        { connection_id: 'conn-acme-2', trust_levels: { read: 'prudent' } },
      ],
      [acmeConnection(), second],
    );
    expect(codes(sameProvider)).toEqual(['duplicate-provider']);
    // The refusal names both connections, says why, and says what to do instead.
    const [issue] = sameProvider.issues;
    expect(issue?.message).toContain('one connection per provider');
    expect(issue?.message).toContain(acmeConnection().display_name);
    expect(issue?.message).toContain(second.display_name);
    expect(issue?.message).toContain('counted per provider');
    expect(issue?.message).toContain('issue a second mission for the other');
  });

  it('resolves a connection named by provider, and refuses an ambiguous one', () => {
    const byProvider = preview([{ provider: 'acme', trust_levels: { read: 'prudent' } }]);
    expect(byProvider.ok).toBe(true);
    expect(byProvider.resolved[0]?.connection_id).toBe('conn-acme');
    const ambiguous = preview(
      [{ provider: 'acme', trust_levels: { read: 'prudent' } }],
      [acmeConnection(), acmeConnection({ id: 'conn-acme-2' })],
    );
    expect(codes(ambiguous)).toEqual(['connection-ambiguous']);
    expect(codes(preview([{ provider: 'nope', trust_levels: { read: 'prudent' } }]))).toEqual([
      'connection-unknown',
    ]);
    expect(codes(preview([{ trust_levels: { read: 'prudent' } }]))).toEqual(['connection-unknown']);
  });
});

describe('previewDraft — resource selection', () => {
  it('resolves "all" to the explicit list known now', () => {
    const p = preview([{ connection_id: 'conn-acme', trust_levels: { read: 'prudent' } }]);
    expect(p.resolved[0]?.resources).toEqual({
      scope: 'selected',
      resource_ids: ['res-app-staging', 'res-app-prod', 'res-scratch'],
    });
  });

  it('accepts a selection by id or by ref, in the connection order', () => {
    const p = preview([
      {
        connection_id: 'conn-acme',
        trust_levels: { read: 'prudent' },
        resources: {
          scope: 'selected',
          resource_ids: ['res-scratch'],
          resource_refs: ['app-prod'],
        },
      },
    ]);
    expect(p.ok).toBe(true);
    expect(p.connections[0]?.resources.map((r) => r.ref)).toEqual(['app-prod', 'scratch']);
    expect(p.connections[0]?.resources_total).toBe(3);
  });

  it('refuses a resource that does not belong to the connection', () => {
    const p = preview([
      {
        connection_id: 'conn-acme',
        trust_levels: { read: 'prudent' },
        resources: { scope: 'selected', resource_ids: ['res-app-prod', 'res-of-another'] },
      },
    ]);
    expect(codes(p)).toEqual(['resource-not-in-connection']);
    expect(p.issues[0]?.resource_refs).toEqual(['res-of-another']);
  });

  it('refuses an empty selection', () => {
    const p = preview([
      {
        connection_id: 'conn-acme',
        trust_levels: { read: 'prudent' },
        resources: { scope: 'selected' },
      },
    ]);
    expect(codes(p)).toEqual(['no-resource-selected']);
  });

  it('leaves hidden and stale resources out of "all"', () => {
    const curated = acmeConnection({ resources: [...ACME_RESOURCES, ACME_HIDDEN, ACME_STALE] });
    const p = preview(
      [{ connection_id: 'conn-acme', trust_levels: { read: 'prudent' } }],
      [curated],
    );
    expect(p.ok).toBe(true);
    expect(idsOf(p.resolved[0])).toEqual(['res-app-staging', 'res-app-prod', 'res-scratch']);
    expect(p.connections[0]?.resources_total).toBe(3);
  });

  it('lets the creator select a hidden resource explicitly, never a stale one', () => {
    const curated = acmeConnection({ resources: [...ACME_RESOURCES, ACME_HIDDEN, ACME_STALE] });
    const hidden = preview(
      [
        {
          connection_id: 'conn-acme',
          trust_levels: { read: 'prudent' },
          resources: { scope: 'selected', resource_refs: ['app-prod', 'archive'] },
        },
      ],
      [curated],
    );
    expect(hidden.ok).toBe(true);
    expect(hidden.connections[0]?.resources.map((r) => r.ref)).toEqual(['app-prod', 'archive']);
    expect(hidden.connections[0]?.resources_total).toBe(4);

    const stale = preview(
      [
        {
          connection_id: 'conn-acme',
          trust_levels: { read: 'prudent' },
          resources: { scope: 'selected', resource_ids: ['res-app-prod', 'res-gone'] },
        },
      ],
      [curated],
    );
    expect(codes(stale)).toEqual(['resource-stale']);
    expect(stale.issues[0]?.resource_refs).toEqual(['gone']);
    expect(stale.connections[0]?.resources.map((r) => r.ref)).toEqual(['app-prod']);
  });

  it('never lets the instance\'s own resource into a mission: out of "all", refused when selected', () => {
    const own = { ...ACME_RESOURCES[1]!, id: 'res-self', ref: 'gateway-host', self: true };
    const withSelf = acmeConnection({ resources: [...ACME_RESOURCES, own] });

    const all = preview(
      [{ connection_id: 'conn-acme', trust_levels: { read: 'prudent' } }],
      [withSelf],
    );
    expect(all.ok).toBe(true);
    expect(idsOf(all.resolved[0])).not.toContain('res-self');
    expect(all.connections[0]?.resources_total).toBe(3);

    for (const resources of [
      { scope: 'selected', resource_ids: ['res-app-prod', 'res-self'] },
      { scope: 'selected', resource_refs: ['app-prod', 'gateway-host'] },
    ] as const) {
      const picked = preview(
        [{ connection_id: 'conn-acme', trust_levels: { read: 'prudent' }, resources }],
        [withSelf],
      );
      expect(picked.ok).toBe(false);
      expect(codes(picked)).toEqual(['resource-self']);
      expect(picked.issues[0]?.resource_refs).toEqual(['gateway-host']);
      expect(picked.connections[0]?.resources.map((r) => r.ref)).toEqual(['app-prod']);
    }

    const onlySelf = preview(
      [
        {
          connection_id: 'conn-acme',
          trust_levels: { read: 'prudent' },
          resources: { scope: 'selected', resource_ids: ['res-self'] },
        },
      ],
      [withSelf],
    );
    expect(codes(onlySelf)).toEqual(['resource-self']);
  });

  it('does not let a stale resource resolve an env-qualified risk', () => {
    const onlyStaleStaging = acmeConnection({
      resources: [ACME_RESOURCES[1]!, ACME_STALE],
    });
    const p = preview(
      [
        {
          connection_id: 'conn-acme',
          policy: [{ risk_id: 'acme[staging].write', ...BUDGET }],
        },
      ],
      [onlyStaleStaging],
    );
    expect(codes(p)).toEqual(['unresolvable-env']);
  });

  it('lets a connection with no known resource through with an empty list', () => {
    const p = preview(
      [{ connection_id: 'conn-acme', trust_levels: { read: 'prudent' } }],
      [acmeConnection({ resources: [] })],
    );
    expect(p.ok).toBe(true);
    expect(idsOf(p.resolved[0])).toEqual([]);
  });
});

describe('previewDraft — env-qualified risks resolve against the selected resources', () => {
  const policy = [
    { risk_id: 'acme[staging].write', ...BUDGET },
    { risk_id: 'acme[prod].write', ...BUDGET },
  ];

  it('passes an env-qualified entry when a selected resource carries the env', () => {
    expect(preview([{ connection_id: 'conn-acme', policy }]).ok).toBe(true);
  });

  it('shows and refuses the entries whose env no selected resource carries', () => {
    const p = preview([
      {
        connection_id: 'conn-acme',
        policy,
        resources: { scope: 'selected', resource_refs: ['app-prod', 'scratch'] },
      },
    ]);
    expect(codes(p)).toEqual(['unresolvable-env']);
    expect(p.connections[0]?.unresolvable).toEqual([
      { risk_id: 'acme[staging].write', env: 'staging' },
    ]);
    expect(p.issues[0]?.message).toContain('"staging"');
    expect(p.connections[0]?.passes.map((e) => e.risk_id)).toEqual(['acme[prod].write']);
  });

  it('needs no label when the plugin derives the env from the call', () => {
    const p = preview(
      [
        {
          connection_id: 'conn-acme',
          policy,
          resources: { scope: 'selected', resource_refs: ['scratch'] },
        },
      ],
      [acmeConnection({ derives_env: true })],
    );
    expect(p.ok).toBe(true);
  });
});

describe('previewDraft — budget is mandatory', () => {
  it('refuses an accepted risk with no resolved budget', () => {
    const p = preview([
      {
        connection_id: 'conn-acme',
        policy: [{ risk_id: 'acme.read', ...BUDGET }, { risk_id: 'acme.admin' }],
      },
    ]);
    expect(codes(p)).toEqual(['missing-budget']);
    expect(p.connections[0]?.missing_budget).toEqual(['acme.admin']);
  });

  it('refuses a quota alone, or a rate limit alone', () => {
    const p = preview([
      {
        connection_id: 'conn-acme',
        policy: [
          { risk_id: 'acme.read', quota: 10 },
          { risk_id: 'acme.admin', rate_limit: { max: 1, window_seconds: 60 } },
        ],
      },
    ]);
    expect(p.connections[0]?.missing_budget).toEqual(['acme.read', 'acme.admin']);
  });

  it('refuses zero, negative, fractional and unbounded values', () => {
    const risk = { rate_ceiling_per_minute: null };
    const ok = { quota: 1, rate_limit: { max: 1, window_seconds: 1 }, gate: 'auto' as const };
    expect(budgetProblem(ok, risk)).toBeNull();
    expect(budgetProblem({ ...ok, quota: 0 }, risk)).toMatch(/quota/);
    expect(budgetProblem({ ...ok, quota: -3 }, risk)).toMatch(/quota/);
    expect(budgetProblem({ ...ok, quota: 1.5 }, risk)).toMatch(/quota/);
    expect(budgetProblem({ ...ok, quota: Number.POSITIVE_INFINITY }, risk)).toMatch(/quota/);
    expect(budgetProblem({ ...ok, rate_limit: { max: 0, window_seconds: 60 } }, risk)).toMatch(
      /rate limit/,
    );
    expect(budgetProblem({ ...ok, rate_limit: { max: 1, window_seconds: 0 } }, risk)).toMatch(
      /window/,
    );
  });

  it('bounds the rate limit by the catalog ceiling', () => {
    const fast = preview([
      {
        connection_id: 'conn-acme',
        policy: [{ risk_id: 'acme.admin', quota: 5, rate_limit: { max: 11, window_seconds: 60 } }],
      },
    ]);
    expect(codes(fast)).toEqual(['invalid-budget']);
    expect(fast.issues[0]?.message).toContain('10 per minute');
    const scaled = preview([
      {
        connection_id: 'conn-acme',
        policy: [{ risk_id: 'acme.admin', quota: 5, rate_limit: { max: 20, window_seconds: 120 } }],
      },
    ]);
    expect(scaled.ok).toBe(true);
  });
});

describe('previewDraft — macro-actions at a trust level', () => {
  it('writes the explicit lines of the ticked macro-actions, gate from the palier, budget from the trust level', () => {
    const p = preview([
      { connection_id: 'conn-acme', trust_levels: { read: 'prudent', change: 'confiant' } },
    ]);
    expect(p.ok).toBe(true);
    expect(p.connections[0]?.preset).toBeNull();
    expect(p.connections[0]?.trust_levels).toEqual({ read: 'prudent', change: 'confiant' });
    expect(p.policy).toEqual([
      {
        risk_id: 'acme.read',
        quota: 100,
        rate_limit: { max: 60, window_seconds: 60 },
        gate: 'auto',
      },
      {
        risk_id: 'acme[staging].write',
        quota: 300,
        rate_limit: { max: 180, window_seconds: 60 },
        gate: 'approval',
      },
      {
        risk_id: 'acme[prod].write',
        quota: 300,
        rate_limit: { max: 180, window_seconds: 60 },
        gate: 'approval',
      },
      {
        risk_id: 'acme[staging].bulk-delete',
        quota: 15,
        rate_limit: { max: 3, window_seconds: 60 },
        gate: 'approval',
      },
    ]);
  });

  it('leaves out what the trust level does not accept, and says so', () => {
    const p = preview([{ connection_id: 'conn-acme', trust_levels: { change: 'prudent' } }]);
    expect(p.ok).toBe(true);
    expect(p.policy.map((e) => [e.risk_id, e.gate])).toEqual([
      ['acme[staging].write', 'approval'],
      ['acme[prod].write', 'approval'],
    ]);
    expect(p.connections[0]?.left_out).toEqual([
      { risk_id: 'acme[staging].bulk-delete', reason: 'trust-level', env: 'staging' },
    ]);
  });

  it('intersects the trust levels with the authority and reports what they left out', () => {
    const p = preview(
      [{ connection_id: 'conn-acme', trust_levels: { read: 'prudent', change: 'confiant' } }],
      [acmeConnection({ authority: ['acme.read', 'acme[staging].write'] })],
    );
    expect(p.ok).toBe(true);
    expect(p.policy.map((e) => e.risk_id)).toEqual(['acme.read', 'acme[staging].write']);
    expect(p.connections[0]?.left_out).toEqual([
      { risk_id: 'acme[prod].write', reason: 'outside-authority', env: 'prod' },
      { risk_id: 'acme[staging].bulk-delete', reason: 'outside-authority', env: 'staging' },
    ]);
  });

  it('leaves out the lines no selected resource can resolve', () => {
    const p = preview([
      {
        connection_id: 'conn-acme',
        trust_levels: { read: 'prudent', change: 'confiant' },
        resources: { scope: 'selected', resource_refs: ['app-prod'] },
      },
    ]);
    expect(p.ok).toBe(true);
    expect(p.policy.map((e) => e.risk_id)).toEqual(['acme.read', 'acme[prod].write']);
    expect(p.connections[0]?.left_out.map((s) => [s.risk_id, s.reason])).toEqual([
      ['acme[staging].write', 'unresolvable-env'],
      ['acme[staging].bulk-delete', 'unresolvable-env'],
    ]);

    const noLabel = preview([
      {
        connection_id: 'conn-acme',
        trust_levels: { change: 'confiant' },
        resources: { scope: 'selected', resource_refs: ['scratch'] },
      },
    ]);
    expect(codes(noLabel)).toEqual(['no-accepted-risk']);
  });

  it('pre-fills a write-token risk asking first at every trust level', () => {
    const p = preview(
      [{ connection_id: 'conn-acme', trust_levels: { read: 'autonome' } }],
      [acmeConnection({ write_token_risks: ['acme.read'] })],
    );
    expect(p.policy.map((e) => [e.risk_id, e.gate])).toEqual([['acme.read', 'approval']]);
  });

  it('beside explicit lines the trust levels decide nothing: the lines are the policy, each with its budget', () => {
    const p = preview([
      {
        connection_id: 'conn-acme',
        trust_levels: { read: 'prudent', change: 'confiant' },
        policy: [{ risk_id: 'acme.read', ...BUDGET, gate: 'approval' }, { risk_id: 'acme.admin' }],
      },
    ]);
    expect(codes(p)).toEqual(['missing-budget']);
    expect(p.connections[0]?.missing_budget).toEqual(['acme.admin']);
    expect(p.connections[0]?.passes).toEqual([
      { risk_id: 'acme.read', ...BUDGET, gate: 'approval' },
    ]);
    expect(p.connections[0]?.left_out).toEqual([]);
    // Kept to redraw the form.
    expect(p.connections[0]?.trust_levels).toEqual({ read: 'prudent', change: 'confiant' });
  });

  it('refuses a preset, an unknown macro-action, a repeated risk and a connection that accepts nothing', () => {
    expect(codes(preview([{ connection_id: 'conn-acme', preset: 'developer' }]))).toEqual([
      'unknown-preset',
      'no-accepted-risk',
    ]);
    expect(
      codes(preview([{ connection_id: 'conn-acme', trust_levels: { deploy: 'prudent' } }])),
    ).toEqual(['unknown-macro-action', 'no-accepted-risk']);
    // Beside explicit lines an unknown macro-action only redraws nothing: it is dropped.
    const beside = preview([
      {
        connection_id: 'conn-acme',
        trust_levels: { deploy: 'prudent' },
        policy: [{ risk_id: 'acme.read', ...BUDGET }],
      },
    ]);
    expect(beside.ok).toBe(true);
    expect(beside.connections[0]?.trust_levels).toEqual({});
    expect(
      codes(
        preview([
          {
            connection_id: 'conn-acme',
            policy: [
              { risk_id: 'acme.read', ...BUDGET },
              { risk_id: 'acme.read', ...BUDGET },
            ],
          },
        ]),
      ),
    ).toEqual(['duplicate-risk']);
    expect(codes(preview([{ connection_id: 'conn-acme' }]))).toEqual(['no-accepted-risk']);
    expect(
      codes(
        preview(
          [{ connection_id: 'conn-acme', trust_levels: { read: 'prudent' } }],
          [acmeConnection({ authority: ['acme.admin'] })],
        ),
      ),
    ).toEqual(['no-accepted-risk']);
  });
});

describe('previewDraft — name, period, expiry', () => {
  const one: DraftConnection[] = [
    { connection_id: 'conn-acme', trust_levels: { read: 'prudent' } },
  ];

  it('needs a name and at least one connection', () => {
    expect(codes(preview(one, undefined, { name: '   ' }))).toEqual(['name-missing']);
    expect(codes(preview(one, undefined, { name: 'x'.repeat(121) }))).toEqual(['name-missing']);
    expect(codes(preview([]))).toEqual(['no-connection']);
    expect(preview(one, undefined, { name: '  Trim me  ' }).name).toBe('Trim me');
  });

  it('accepts a one-off mission and a recurring one, refuses a nonsensical period', () => {
    expect(preview(one, undefined, { period: { kind: 'one-off' } }).ok).toBe(true);
    expect(
      codes(preview(one, undefined, { period: { kind: 'recurring', length_seconds: 0 } })),
    ).toEqual(['invalid-period']);
    expect(
      codes(preview(one, undefined, { period: { kind: 'recurring', length_seconds: 90.5 } })),
    ).toEqual(['invalid-period']);
  });

  it('accepts no expiry and a future one, refuses a past or malformed one', () => {
    expect(preview(one, undefined, { expires_at: null }).ok).toBe(true);
    expect(preview(one, undefined, { expires_at: '2026-11-13T09:00:00.000Z' }).ok).toBe(true);
    expect(codes(preview(one, undefined, { expires_at: '2026-10-13T09:00:00.000Z' }))).toEqual([
      'invalid-expiry',
    ]);
    expect(codes(preview(one, undefined, { expires_at: 'tomorrow' }))).toEqual(['invalid-expiry']);
  });

  it('reports every problem of a draft in one pass', () => {
    const p = preview(
      [
        {
          connection_id: 'conn-acme',
          resources: { scope: 'selected', resource_ids: ['nope'] },
          policy: [{ risk_id: 'acme.read' }, { risk_id: 'acme.nope', ...BUDGET }],
        },
      ],
      undefined,
      { name: '', expires_at: 'x', period: { kind: 'recurring', length_seconds: 1 } },
    );
    expect(codes(p).sort()).toEqual(
      [
        'invalid-expiry',
        'invalid-period',
        'missing-budget',
        'name-missing',
        'resource-not-in-connection',
        'unknown-risk',
      ].sort(),
    );
  });
});

describe('previewConnection', () => {
  it('is the same decision the whole-draft preview makes for one connection', () => {
    const draft: DraftConnection = {
      connection_id: 'conn-acme',
      trust_levels: { read: 'prudent', change: 'confiant' },
    };
    const single = previewConnection(acmeConnection(), draft);
    expect(single.issues).toEqual([]);
    expect(single.preview).toEqual(preview([draft]).connections[0]);
  });
});

describe('previewDraft — notices (never blocking)', () => {
  const all: DraftConnection[] = [
    { connection_id: 'conn-acme', trust_levels: { read: 'prudent', change: 'confiant' } },
  ];

  it('names the selected resources that carry no environment label and what it costs', () => {
    const p = preview(all);
    expect(p.ok).toBe(true);
    expect(p.issues).toEqual([]);
    expect(p.notices).toHaveLength(1);
    expect(p.notices).toMatchObject([
      {
        code: 'resource-without-env',
        resource_refs: ['scratch'],
        risk_ids: ['acme[staging].write', 'acme[prod].write', 'acme[staging].bulk-delete'],
        connection_index: 0,
        connection_id: 'conn-acme',
      },
    ]);
    // Named as the pages name it (its display name); the ref stays in `resource_refs`.
    expect(p.notices[0]?.message).toContain('No environment label on Scratch ("Acme main").');
    expect(p.notices[0]?.message).toContain('refused (risk-not-accepted)');
    expect(p.notices[0]?.message).toContain('(staging, prod)');
  });

  it('says nothing when every selected resource is labelled with an environment of the catalog', () => {
    const p = preview([
      {
        connection_id: 'conn-acme',
        trust_levels: { read: 'prudent', change: 'confiant' },
        resources: { scope: 'selected', resource_ids: ['res-app-staging', 'res-app-prod'] },
      },
    ]);
    expect(p.notices).toEqual([]);
  });

  it('names a resource labelled with an environment no risk of the catalog is acceptable in', () => {
    const dev = { ...ACME_RESOURCES[0]!, id: 'res-dev', ref: 'app-dev', env: 'dev' };
    const p = preview(
      [
        {
          connection_id: 'conn-acme',
          policy: [{ risk_id: 'acme.read', ...BUDGET }],
          resources: { scope: 'selected', resource_ids: ['res-dev'] },
        },
      ],
      [acmeConnection({ resources: [dev] })],
    );
    expect(p.ok).toBe(true);
    expect(p.notices.map((n) => [n.code, n.resource_refs, n.risk_ids])).toEqual([
      ['resource-env-not-in-catalog', ['app-dev'], []],
    ]);
  });

  it('says nothing when the plugin derives the environment, or the catalog has no env-scoped risk', () => {
    const where = { connection_index: 0, connection_id: 'conn-acme' };
    const unlabelled = [{ ref: 'scratch', env: null }];
    const acme = acmeConnection();
    expect(envNotices({ ...acme, derives_env: true }, unlabelled, [], where)).toEqual([]);
    const accountOnly = acme.risks.filter((r) => r.env === null);
    expect(envNotices({ ...acme, risks: accountOnly }, unlabelled, [], where)).toEqual([]);
    expect(envNotices(acme, unlabelled, [], where)).toHaveLength(1);
  });

  it('keeps a notice out of `ok`: a draft with a notice and no issue is issuable', () => {
    const p = preview(all);
    expect(p.notices.length).toBeGreaterThan(0);
    expect(p.ok).toBe(true);
  });
});

describe('previewDraft — the whole connection (scope `connection`)', () => {
  it('is judged on the resources known now and resolved as the scope, not as a list', () => {
    const curated = acmeConnection({ resources: [...ACME_RESOURCES, ACME_HIDDEN, ACME_STALE] });
    const p = preview(
      [
        {
          connection_id: 'conn-acme',
          trust_levels: { read: 'prudent' },
          resources: { scope: 'connection' },
        },
      ],
      [curated],
    );
    expect(p.ok).toBe(true);
    expect(p.resolved[0]?.resources).toEqual({ scope: 'connection' });
    expect(p.connections[0]?.reaches_later).toBe(true);
    // What it reaches now: neither hidden nor stale.
    expect(p.connections[0]?.resources.map((r) => r.id)).toEqual([
      'res-app-staging',
      'res-app-prod',
      'res-scratch',
    ]);
    expect(p.summary.can).toContain('the whole account, resources found later included');
  });

  it('passes on a connection with no resource yet: later ones will be reached', () => {
    const empty = acmeConnection({ resources: [] });
    const p = preview(
      [
        {
          connection_id: 'conn-acme',
          trust_levels: { read: 'prudent' },
          resources: { scope: 'connection' },
        },
      ],
      [empty],
    );
    expect(p.ok).toBe(true);
    expect(p.resolved[0]?.resources).toEqual({ scope: 'connection' });
  });

  it('checks an env-qualified risk against the resources known now, and says later ones need a label', () => {
    const line = {
      risk_id: 'acme[prod].write',
      quota: 5,
      rate_limit: { max: 1, window_seconds: 60 },
    };
    const refused = preview(
      [{ connection_id: 'conn-acme', resources: { scope: 'connection' }, policy: [line] }],
      [acmeConnection({ resources: [] })],
    );
    expect(codes(refused)).toEqual(['unresolvable-env']);

    const p = preview([
      { connection_id: 'conn-acme', resources: { scope: 'connection' }, policy: [line] },
    ]);
    expect(p.ok).toBe(true);
    expect(p.notices.filter((n) => n.code === 'later-resources-need-env-label')).toEqual([
      expect.objectContaining({
        connection_id: 'conn-acme',
        resource_refs: [],
        risk_ids: ['acme[prod].write'],
      }),
    ]);
  });

  it('says nothing about later labels when the plugin derives the environment, or the connection has a default', () => {
    for (const connection of [
      acmeConnection({ derives_env: true }),
      acmeConnection({ default_env: 'staging' }),
    ]) {
      const p = preview(
        [
          {
            connection_id: 'conn-acme',
            trust_levels: { read: 'prudent' },
            resources: { scope: 'connection' },
          },
        ],
        [connection],
      );
      expect(p.notices.map((n) => n.code)).not.toContain('later-resources-need-env-label');
    }
  });

  it('`all` stays the list known now: no later resource, no notice about one', () => {
    const p = preview([{ connection_id: 'conn-acme', trust_levels: { read: 'prudent' } }]);
    expect(p.connections[0]?.reaches_later).toBe(false);
    expect(p.resolved[0]?.resources.scope).toBe('selected');
    expect(p.notices.map((n) => n.code)).not.toContain('later-resources-need-env-label');
  });
});
