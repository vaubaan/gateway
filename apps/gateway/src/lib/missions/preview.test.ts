import { describe, expect, it } from 'vitest';

import type {
  DraftAccount,
  IssuanceAccount,
  MissionDraft,
  PreviewIssueCode,
  ResolvedDraftAccount,
} from './model';
import {
  budgetProblem,
  envNotices,
  normalizeDraft,
  previewAccount,
  previewDraft,
  uncoveredOf,
} from './preview';
import {
  ACME_HIDDEN,
  ACME_RESOURCES,
  ACME_STALE,
  acmeAccount,
} from '../../../tests/support/missions/testing';

/** The explicit ids of the first set of a resolved line. */
function idsOf(line: ResolvedDraftAccount | undefined): readonly string[] | undefined {
  return line?.resource_sets[0]?.resources.resource_ids;
}

const NOW = new Date('2026-10-13T09:00:00.000Z');
const BUDGET = { quota: 10, rate_limit: { max: 5, window_seconds: 60 } } as const;
/**
 * One environment of the Acme account: a test about something else than environments
 * selects it, so that its draft is one resource set (a set holds one environment).
 */
const STAGING = { scope: 'selected', resource_ids: ['res-app-staging'] } as const;
const PROD = { scope: 'selected', resource_ids: ['res-app-prod'] } as const;

function draftOf(
  accounts: readonly DraftAccount[],
  overrides: Partial<MissionDraft> = {},
): MissionDraft {
  return {
    name: 'Ship the billing page',
    accounts,
    period: { kind: 'recurring', length_seconds: 86_400 },
    expires_at: null,
    ...overrides,
  };
}

function preview(
  accounts: readonly DraftAccount[],
  context: readonly IssuanceAccount[] = [acmeAccount()],
  overrides: Partial<MissionDraft> = {},
) {
  return previewDraft({ accounts: context, now: NOW }, draftOf(accounts, overrides));
}

function codes(p: { issues: readonly { code: PreviewIssueCode }[] }): PreviewIssueCode[] {
  return p.issues.map((i) => i.code);
}

describe('previewDraft — authority (monotonicity)', () => {
  it('passes a draft whose accepted risks are inside the authority', () => {
    const p = preview([
      {
        account_id: 'conn-acme',
        resources: STAGING,
        policy: [{ risk_id: 'acme.read', ...BUDGET }],
      },
    ]);
    expect(p.ok).toBe(true);
    expect(p.policy).toEqual([{ risk_id: 'acme.read', ...BUDGET, gate: 'auto' }]);
  });

  it('refuses accepted ⊄ authority with the explicit uncovered list', () => {
    const restricted = acmeAccount({ authority: ['acme.read', 'acme[staging].write'] });
    const p = preview(
      [
        {
          account_id: 'conn-acme',
          resources: PROD,
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
    expect(p.accounts[0]?.passes.map((e) => e.risk_id)).toEqual(['acme.read']);
  });

  it('refuses a wildcard, a sentinel and an id of another catalog as unknown risks', () => {
    const p = preview([
      {
        account_id: 'conn-acme',
        policy: [
          { risk_id: 'acme.*', ...BUDGET },
          { risk_id: '*', ...BUDGET },
          { risk_id: 'github.code-read', ...BUDGET },
          { risk_id: 'acme[dev].write', ...BUDGET },
        ],
      },
    ]);
    expect(codes(p)).toContain('unknown-risk');
    expect(p.accounts[0]?.unknown).toEqual(['acme.*', '*', 'github.code-read', 'acme[dev].write']);
    expect(p.policy).toEqual([]);
  });

  it('answers the same for an account that does not exist and one the creator holds nothing on', () => {
    const p = preview([{ account_id: 'conn-of-someone-else', trust_levels: { read: 'careful' } }]);
    expect(codes(p)).toEqual(['account-unknown']);
    expect(p.accounts).toEqual([]);
  });

  it('refuses an account that is not active', () => {
    const p = preview(
      [{ account_id: 'conn-acme', trust_levels: { read: 'careful' } }],
      [acmeAccount({ status: 'expired' })],
    );
    expect(codes(p)).toEqual(['account-unavailable']);
  });
});

describe('previewDraft — partition per account', () => {
  const beta = acmeAccount({
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
        },
        kind: 'read',
        row: 1,
        row_reason: null,
        fallback: false,
        deprecated: false,
        rate_ceiling_per_minute: null,
      },
    ],
    authority: [],
  });

  it('checks each partition against the authority on its own account', () => {
    const p = preview(
      [
        { account_id: 'conn-acme', policy: [{ risk_id: 'acme.read', ...BUDGET }] },
        { account_id: 'conn-beta', policy: [{ risk_id: 'beta.read', ...BUDGET }] },
      ],
      [acmeAccount(), beta],
    );
    expect(codes(p)).toEqual(['exceeds-authority']);
    expect(p.issues[0]).toMatchObject({ account_id: 'conn-beta', risk_ids: ['beta.read'] });
    expect(p.accounts[0]?.exceeds).toEqual([]);
    expect(p.accounts[1]?.exceeds).toEqual(['beta.read']);
  });

  it('refuses a risk filed under the wrong account', () => {
    const p = preview(
      [
        {
          account_id: 'conn-acme',
          resources: STAGING,
          policy: [
            { risk_id: 'acme.read', ...BUDGET },
            { risk_id: 'beta.read', ...BUDGET },
          ],
        },
      ],
      [acmeAccount(), { ...beta, authority: ['beta.read'] }],
    );
    expect(codes(p)).toEqual(['unknown-risk']);
    expect(p.issues[0]?.risk_ids).toEqual(['beta.read']);
  });

  it('yields one flat policy out of the partitions', () => {
    const p = preview(
      [
        {
          account_id: 'conn-acme',
          resources: STAGING,
          policy: [{ risk_id: 'acme.read', ...BUDGET }],
        },
        { account_id: 'conn-beta', policy: [{ risk_id: 'beta.read', ...BUDGET }] },
      ],
      [acmeAccount(), { ...beta, authority: ['beta.read'] }],
    );
    expect(p.ok).toBe(true);
    expect(p.policy.map((e) => e.risk_id)).toEqual(['acme.read', 'beta.read']);
    expect(p.resolved.map((c) => c.account_id)).toEqual(['conn-acme', 'conn-beta']);
  });

  it('refuses the same account twice and two accounts of one provider', () => {
    const second = acmeAccount({ id: 'conn-acme-2', display_name: 'Acme second' });
    const twice = preview([
      { account_id: 'conn-acme', trust_levels: { read: 'careful' } },
      { account_id: 'conn-acme', trust_levels: { read: 'careful' } },
    ]);
    expect(codes(twice)).toEqual(['duplicate-account']);
    const sameProvider = preview(
      [
        { account_id: 'conn-acme', trust_levels: { read: 'careful' } },
        { account_id: 'conn-acme-2', trust_levels: { read: 'careful' } },
      ],
      [acmeAccount(), second],
    );
    expect(codes(sameProvider)).toEqual(['duplicate-provider']);
    // The refusal names both accounts, says why, and says what to do instead.
    const [issue] = sameProvider.issues;
    expect(issue?.message).toContain('one account per provider');
    expect(issue?.message).toContain(acmeAccount().display_name);
    expect(issue?.message).toContain(second.display_name);
    expect(issue?.message).toContain('counted per provider');
    expect(issue?.message).toContain('issue a second mission for the other');
  });

  it('resolves an account named by provider, and refuses an ambiguous one', () => {
    const byProvider = preview([{ provider: 'acme', trust_levels: { read: 'careful' } }]);
    expect(byProvider.ok).toBe(true);
    expect(byProvider.resolved[0]?.account_id).toBe('conn-acme');
    const ambiguous = preview(
      [{ provider: 'acme', trust_levels: { read: 'careful' } }],
      [acmeAccount(), acmeAccount({ id: 'conn-acme-2' })],
    );
    expect(codes(ambiguous)).toEqual(['account-ambiguous']);
    expect(codes(preview([{ provider: 'nope', trust_levels: { read: 'careful' } }]))).toEqual([
      'account-unknown',
    ]);
    expect(codes(preview([{ trust_levels: { read: 'careful' } }]))).toEqual(['account-unknown']);
  });
});

describe('previewDraft — resource selection', () => {
  it('resolves "all" to the explicit lists known now, one per environment, the unlabelled left out', () => {
    const p = preview([{ account_id: 'conn-acme', trust_levels: { read: 'careful' } }]);
    expect(p.resolved[0]?.resource_sets.map((set) => set.resources)).toEqual([
      { scope: 'selected', resource_ids: ['res-app-staging'] },
      { scope: 'selected', resource_ids: ['res-app-prod'] },
    ]);
  });

  it('accepts a selection by id or by ref, in the account order', () => {
    const p = preview([
      {
        account_id: 'conn-acme',
        trust_levels: { read: 'careful' },
        resources: {
          scope: 'selected',
          resource_ids: ['res-app-prod'],
          resource_refs: ['app-staging'],
        },
      },
    ]);
    expect(p.ok).toBe(true);
    expect(p.accounts[0]?.resources.map((r) => r.ref)).toEqual(['app-staging', 'app-prod']);
    expect(p.accounts[0]?.resources_total).toBe(3);
  });

  it('refuses a resource that does not belong to the account', () => {
    const p = preview([
      {
        account_id: 'conn-acme',
        trust_levels: { read: 'careful' },
        resources: { scope: 'selected', resource_ids: ['res-app-prod', 'res-of-another'] },
      },
    ]);
    expect(codes(p)).toEqual(['resource-not-in-account']);
    expect(p.issues[0]?.resource_refs).toEqual(['res-of-another']);
  });

  it('refuses an empty selection', () => {
    const p = preview([
      {
        account_id: 'conn-acme',
        trust_levels: { read: 'careful' },
        resources: { scope: 'selected' },
      },
    ]);
    expect(codes(p)).toEqual(['no-resource-selected']);
  });

  it('leaves hidden and stale resources out of "all"', () => {
    const curated = acmeAccount({ resources: [...ACME_RESOURCES, ACME_HIDDEN, ACME_STALE] });
    const p = preview([{ account_id: 'conn-acme', trust_levels: { read: 'careful' } }], [curated]);
    expect(p.ok).toBe(true);
    expect(p.accounts[0]?.resources.map((r) => r.id)).toEqual(['res-app-staging', 'res-app-prod']);
    expect(p.accounts[0]?.resources_total).toBe(3);
  });

  it('lets the creator select a hidden resource explicitly, never a stale one', () => {
    const curated = acmeAccount({ resources: [...ACME_RESOURCES, ACME_HIDDEN, ACME_STALE] });
    const hidden = preview(
      [
        {
          account_id: 'conn-acme',
          trust_levels: { read: 'careful' },
          resources: { scope: 'selected', resource_refs: ['app-prod', 'archive'] },
        },
      ],
      [curated],
    );
    expect(hidden.ok).toBe(true);
    expect(hidden.accounts[0]?.resources.map((r) => r.ref)).toEqual(['app-prod', 'archive']);
    expect(hidden.accounts[0]?.resources_total).toBe(4);

    const stale = preview(
      [
        {
          account_id: 'conn-acme',
          trust_levels: { read: 'careful' },
          resources: { scope: 'selected', resource_ids: ['res-app-prod', 'res-gone'] },
        },
      ],
      [curated],
    );
    expect(codes(stale)).toEqual(['resource-stale']);
    expect(stale.issues[0]?.resource_refs).toEqual(['gone']);
    expect(stale.accounts[0]?.resources.map((r) => r.ref)).toEqual(['app-prod']);
  });

  it('never lets the instance\'s own resource into a mission: out of "all", refused when selected', () => {
    const own = { ...ACME_RESOURCES[1]!, id: 'res-self', ref: 'gateway-host', self: true };
    const withSelf = acmeAccount({ resources: [...ACME_RESOURCES, own] });

    const all = preview(
      [{ account_id: 'conn-acme', trust_levels: { read: 'careful' } }],
      [withSelf],
    );
    expect(all.ok).toBe(true);
    expect(idsOf(all.resolved[0])).not.toContain('res-self');
    expect(all.accounts[0]?.resources_total).toBe(3);

    for (const resources of [
      { scope: 'selected', resource_ids: ['res-app-prod', 'res-self'] },
      { scope: 'selected', resource_refs: ['app-prod', 'gateway-host'] },
    ] as const) {
      const picked = preview(
        [{ account_id: 'conn-acme', trust_levels: { read: 'careful' }, resources }],
        [withSelf],
      );
      expect(picked.ok).toBe(false);
      expect(codes(picked)).toEqual(['resource-self']);
      expect(picked.issues[0]?.resource_refs).toEqual(['gateway-host']);
      expect(picked.accounts[0]?.resources.map((r) => r.ref)).toEqual(['app-prod']);
    }

    const onlySelf = preview(
      [
        {
          account_id: 'conn-acme',
          trust_levels: { read: 'careful' },
          resources: { scope: 'selected', resource_ids: ['res-self'] },
        },
      ],
      [withSelf],
    );
    expect(codes(onlySelf)).toEqual(['resource-self']);
  });

  it('does not let a stale resource resolve an env-qualified risk', () => {
    const onlyStaleStaging = acmeAccount({
      resources: [ACME_RESOURCES[1]!, ACME_STALE],
    });
    const p = preview(
      [
        {
          account_id: 'conn-acme',
          policy: [{ risk_id: 'acme[staging].write', ...BUDGET }],
        },
      ],
      [onlyStaleStaging],
    );
    expect(codes(p)).toEqual(['unresolvable-env']);
  });

  it('lets an account with no known resource through with an empty list', () => {
    const p = preview(
      [{ account_id: 'conn-acme', trust_levels: { read: 'careful' } }],
      [acmeAccount({ resources: [] })],
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
    expect(preview([{ account_id: 'conn-acme', policy }]).ok).toBe(true);
  });

  it('shows and refuses the entries whose env no selected resource carries', () => {
    const p = preview([
      {
        account_id: 'conn-acme',
        policy,
        resources: { scope: 'selected', resource_refs: ['app-prod'] },
      },
    ]);
    expect(codes(p)).toEqual(['unresolvable-env']);
    expect(p.accounts[0]?.unresolvable).toEqual([
      { risk_id: 'acme[staging].write', env: 'staging' },
    ]);
    expect(p.issues[0]?.message).toContain('"staging"');
    expect(p.accounts[0]?.passes.map((e) => e.risk_id)).toEqual(['acme[prod].write']);
  });

  it('needs no label when the plugin derives the env from the call', () => {
    const p = preview(
      [
        {
          account_id: 'conn-acme',
          policy,
          resources: { scope: 'selected', resource_refs: ['scratch'] },
        },
      ],
      [acmeAccount({ derives_env: true })],
    );
    expect(p.ok).toBe(true);
  });
});

describe('previewDraft — budget is mandatory', () => {
  it('refuses an accepted risk with no resolved budget', () => {
    const p = preview([
      {
        account_id: 'conn-acme',
        resources: STAGING,
        policy: [{ risk_id: 'acme.read', ...BUDGET }, { risk_id: 'acme.admin' }],
      },
    ]);
    expect(codes(p)).toEqual(['missing-budget']);
    expect(p.accounts[0]?.missing_budget).toEqual(['acme.admin']);
  });

  it('refuses a quota alone, or a rate limit alone', () => {
    const p = preview([
      {
        account_id: 'conn-acme',
        policy: [
          { risk_id: 'acme.read', quota: 10 },
          { risk_id: 'acme.admin', rate_limit: { max: 1, window_seconds: 60 } },
        ],
      },
    ]);
    expect(p.accounts[0]?.missing_budget).toEqual(['acme.read', 'acme.admin']);
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
        account_id: 'conn-acme',
        resources: STAGING,
        policy: [{ risk_id: 'acme.admin', quota: 5, rate_limit: { max: 11, window_seconds: 60 } }],
      },
    ]);
    expect(codes(fast)).toEqual(['invalid-budget']);
    expect(fast.issues[0]?.message).toContain('10 per minute');
    const scaled = preview([
      {
        account_id: 'conn-acme',
        resources: STAGING,
        policy: [{ risk_id: 'acme.admin', quota: 5, rate_limit: { max: 20, window_seconds: 120 } }],
      },
    ]);
    expect(scaled.ok).toBe(true);
  });
});

describe('previewDraft — macro-actions at a trust level', () => {
  it('writes the explicit lines of the ticked macro-actions, gate from the row, budget from the trust level', () => {
    const p = preview([
      {
        account_id: 'conn-acme',
        trust_levels: { read: 'careful', change: 'trusting' },
        resources: { scope: 'selected', resource_ids: ['res-app-staging', 'res-app-prod'] },
      },
    ]);
    expect(p.ok).toBe(true);
    expect(p.accounts[0]?.everything_i_hold).toBe(false);
    expect(p.accounts[0]?.trust_levels).toEqual({ read: 'careful', change: 'trusting' });
    // Split by environment: each set holds the lines its environment resolves.
    expect(p.accounts[0]?.resource_sets.map((set) => set.passes.map((l) => l.risk_id))).toEqual([
      ['acme.read', 'acme[staging].write', 'acme[staging].bulk-delete'],
      ['acme.read', 'acme[prod].write'],
    ]);
    const byRisk = [...new Map(p.policy.map((l) => [l.risk_id, l])).values()];
    expect(byRisk).toHaveLength(4);
    expect(byRisk).toEqual(
      expect.arrayContaining([
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
      ]),
    );
  });

  it('leaves out what the trust level does not accept, and says so', () => {
    const p = preview([
      {
        account_id: 'conn-acme',
        trust_levels: { change: 'careful' },
        resources: { scope: 'selected', resource_ids: ['res-app-staging', 'res-app-prod'] },
      },
    ]);
    expect(p.ok).toBe(true);
    expect(p.policy.map((e) => [e.risk_id, e.gate])).toEqual([
      ['acme[staging].write', 'approval'],
      ['acme[prod].write', 'approval'],
    ]);
    // Each set also leaves out what the other environment resolves.
    expect(p.accounts[0]?.left_out.filter((l) => l.reason !== 'unresolvable-env')).toEqual([
      { risk_id: 'acme[staging].bulk-delete', reason: 'trust-level', env: 'staging' },
    ]);
  });

  it('intersects the trust levels with the authority and reports what they left out', () => {
    const p = preview(
      [{ account_id: 'conn-acme', trust_levels: { read: 'careful', change: 'trusting' } }],
      [acmeAccount({ authority: ['acme.read', 'acme[staging].write'] })],
    );
    expect(p.ok).toBe(true);
    expect([...new Set(p.policy.map((e) => e.risk_id))]).toEqual([
      'acme.read',
      'acme[staging].write',
    ]);
    // Each set says what it left out (the same risk in both sets, once here).
    const leftOut = new Map(
      (p.accounts[0]?.left_out ?? [])
        .filter((l) => l.reason !== 'unresolvable-env')
        .map((l) => [l.risk_id, l]),
    );
    expect([...leftOut.values()]).toEqual(
      expect.arrayContaining([
        { risk_id: 'acme[prod].write', reason: 'outside-authority', env: 'prod' },
        { risk_id: 'acme[staging].bulk-delete', reason: 'outside-authority', env: 'staging' },
      ]),
    );
    expect(leftOut.size).toBe(2);
  });

  it('leaves out the lines no selected resource can resolve', () => {
    const p = preview([
      {
        account_id: 'conn-acme',
        trust_levels: { read: 'careful', change: 'trusting' },
        resources: { scope: 'selected', resource_refs: ['app-prod'] },
      },
    ]);
    expect(p.ok).toBe(true);
    expect(p.policy.map((e) => e.risk_id)).toEqual(['acme.read', 'acme[prod].write']);
    expect(p.accounts[0]?.left_out.map((s) => [s.risk_id, s.reason])).toEqual([
      ['acme[staging].write', 'unresolvable-env'],
      ['acme[staging].bulk-delete', 'unresolvable-env'],
    ]);

    const noLabel = preview([
      {
        account_id: 'conn-acme',
        trust_levels: { change: 'trusting' },
        resources: { scope: 'selected', resource_refs: ['scratch'] },
      },
    ]);
    // An unlabelled resource cannot enter a set where risks depend on the environment.
    expect(codes(noLabel)).toEqual(['resource-unlabelled', 'no-accepted-risk']);
  });

  it('beside explicit lines the trust levels decide nothing: the lines are the policy, each with its budget', () => {
    const p = preview([
      {
        account_id: 'conn-acme',
        resources: STAGING,
        trust_levels: { read: 'careful', change: 'trusting' },
        policy: [{ risk_id: 'acme.read', ...BUDGET, gate: 'approval' }, { risk_id: 'acme.admin' }],
      },
    ]);
    expect(codes(p)).toEqual(['missing-budget']);
    expect(p.accounts[0]?.missing_budget).toEqual(['acme.admin']);
    expect(p.accounts[0]?.passes).toEqual([{ risk_id: 'acme.read', ...BUDGET, gate: 'approval' }]);
    expect(p.accounts[0]?.left_out).toEqual([]);
    // Kept to redraw the form.
    expect(p.accounts[0]?.trust_levels).toEqual({ read: 'careful', change: 'trusting' });
  });

  it('refuses an unknown macro-action, a repeated risk and an account that accepts nothing', () => {
    expect(
      codes(
        preview([
          { account_id: 'conn-acme', resources: STAGING, trust_levels: { deploy: 'careful' } },
        ]),
      ),
    ).toEqual(['unknown-macro-action', 'no-accepted-risk']);
    // Beside explicit lines an unknown macro-action only redraws nothing: it is dropped.
    const beside = preview([
      {
        account_id: 'conn-acme',
        trust_levels: { deploy: 'careful' },
        policy: [{ risk_id: 'acme.read', ...BUDGET }],
      },
    ]);
    expect(beside.ok).toBe(true);
    expect(beside.accounts[0]?.trust_levels).toEqual({});
    expect(
      codes(
        preview([
          {
            account_id: 'conn-acme',
            resources: STAGING,
            policy: [
              { risk_id: 'acme.read', ...BUDGET },
              { risk_id: 'acme.read', ...BUDGET },
            ],
          },
        ]),
      ),
    ).toEqual(['duplicate-risk']);
    expect(codes(preview([{ account_id: 'conn-acme', resources: STAGING }]))).toEqual([
      'no-accepted-risk',
    ]);
    expect(
      codes(
        preview(
          [{ account_id: 'conn-acme', resources: STAGING, trust_levels: { read: 'careful' } }],
          [acmeAccount({ authority: ['acme.admin'] })],
        ),
      ),
    ).toEqual(['no-accepted-risk']);
  });
});

describe('previewDraft — name, period, expiry', () => {
  const one: DraftAccount[] = [{ account_id: 'conn-acme', trust_levels: { read: 'careful' } }];

  it('needs a name and at least one account', () => {
    expect(codes(preview(one, undefined, { name: '   ' }))).toEqual(['name-missing']);
    expect(codes(preview(one, undefined, { name: 'x'.repeat(121) }))).toEqual(['name-missing']);
    expect(codes(preview([]))).toEqual(['no-account']);
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
          account_id: 'conn-acme',
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
        'resource-not-in-account',
        'unknown-risk',
      ].sort(),
    );
  });
});

describe('previewAccount', () => {
  it('is the same decision the whole-draft preview makes for one account', () => {
    const draft: DraftAccount = {
      account_id: 'conn-acme',
      trust_levels: { read: 'careful', change: 'trusting' },
    };
    const single = previewAccount(acmeAccount(), draft);
    expect(single.issues).toEqual([]);
    expect(single.preview).toEqual(preview([draft]).accounts[0]);
  });
});

describe('previewDraft — notices (never blocking)', () => {
  const all: DraftAccount[] = [
    { account_id: 'conn-acme', trust_levels: { read: 'careful', change: 'trusting' } },
  ];

  it('names the resources "all" left out for want of an environment label, and the split', () => {
    const p = preview(all);
    expect(p.ok).toBe(true);
    expect(p.issues).toEqual([]);
    expect(p.notices.map((n) => n.code)).toEqual([
      'unlabelled-resources-left-out',
      'split-by-environment',
    ]);
    expect(p.notices[0]).toMatchObject({
      resource_refs: ['scratch'],
      account_index: 0,
      account_id: 'conn-acme',
    });
    // Named as the pages name it (its display name); the ref stays in `resource_refs`.
    expect(p.notices[0]?.message).toContain('without an environment label: Scratch.');
  });

  it('says nothing about labels when every selected resource is labelled with an environment of the catalog', () => {
    const p = preview([
      {
        account_id: 'conn-acme',
        trust_levels: { read: 'careful', change: 'trusting' },
        resources: { scope: 'selected', resource_ids: ['res-app-staging', 'res-app-prod'] },
      },
    ]);
    expect(p.notices.map((n) => n.code)).toEqual(['split-by-environment']);
  });

  it('names a resource labelled with an environment no risk of the catalog is acceptable in', () => {
    const dev = { ...ACME_RESOURCES[0]!, id: 'res-dev', ref: 'app-dev', env: 'dev' };
    const p = preview(
      [
        {
          account_id: 'conn-acme',
          policy: [{ risk_id: 'acme.read', ...BUDGET }],
          resources: { scope: 'selected', resource_ids: ['res-dev'] },
        },
      ],
      [acmeAccount({ resources: [dev] })],
    );
    expect(p.ok).toBe(true);
    expect(p.notices.map((n) => [n.code, n.resource_refs, n.risk_ids])).toEqual([
      ['resource-env-not-in-catalog', ['app-dev'], []],
    ]);
  });

  it('says nothing when the plugin derives the environment, or the catalog has no env-scoped risk', () => {
    const where = { account_index: 0, account_id: 'conn-acme' };
    const unlabelled = [{ ref: 'scratch', env: null }];
    const acme = acmeAccount();
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

describe('previewDraft — one environment per set, future resources', () => {
  const prodLine = { risk_id: 'acme[prod].write', ...BUDGET };
  const stagingLine = { risk_id: 'acme[staging].write', ...BUDGET };
  const readLine = { risk_id: 'acme.read', ...BUDGET };
  const setsOf = (p: ReturnType<typeof preview>) =>
    (p.resolved[0]?.resource_sets ?? []).map((set) => ({
      ids: set.resources.resource_ids,
      future: set.future,
      env: set.env,
      risks: set.policy.map((l) => l.risk_id),
    }));

  it('`account` is the known list with future on, split by environment, unlabelled left out', () => {
    const curated = acmeAccount({ resources: [...ACME_RESOURCES, ACME_HIDDEN, ACME_STALE] });
    const p = preview(
      [
        {
          account_id: 'conn-acme',
          resources: { scope: 'account' },
          policy: [readLine, prodLine, stagingLine],
        },
      ],
      [curated],
    );
    expect(p.ok).toBe(true);
    expect(setsOf(p)).toEqual([
      {
        ids: ['res-app-staging'],
        future: true,
        env: 'staging',
        risks: ['acme.read', 'acme[staging].write'],
      },
      {
        ids: ['res-app-prod'],
        future: true,
        env: 'prod',
        risks: ['acme.read', 'acme[prod].write'],
      },
    ]);
    expect(p.accounts[0]?.future).toBe(true);
    expect(p.notices.map((n) => n.code)).toEqual(
      expect.arrayContaining(['unlabelled-resources-left-out', 'split-by-environment']),
    );
    expect(
      p.notices.find((n) => n.code === 'unlabelled-resources-left-out')?.resource_refs,
    ).toEqual(['scratch']);
    expect(p.summary.can).toContain('resources found later included');
  });

  it('on an account with no resource yet, a future set takes the account’s default environment', () => {
    const withDefault = acmeAccount({ resources: [], default_env: 'staging' });
    const p = preview(
      [
        {
          account_id: 'conn-acme',
          trust_levels: { read: 'careful' },
          resources: { scope: 'account' },
        },
      ],
      [withDefault],
    );
    expect(p.ok).toBe(true);
    expect(setsOf(p)).toEqual([{ ids: [], future: true, env: 'staging', risks: ['acme.read'] }]);
    // Without a default, future resources would carry no label: refused where labels matter.
    const bare = preview(
      [
        {
          account_id: 'conn-acme',
          trust_levels: { read: 'careful' },
          resources: { scope: 'account' },
        },
      ],
      [acmeAccount({ resources: [] })],
    );
    expect(codes(bare)).toEqual(['resource-unlabelled']);
    // A set of future resources names its environment itself.
    const named = preview(
      [
        {
          account_id: 'conn-acme',
          resource_sets: [
            {
              resources: { scope: 'selected', resource_ids: [] },
              future: true,
              env: 'prod',
              policy: [prodLine],
            },
          ],
        },
      ],
      [acmeAccount({ resources: [] })],
    );
    expect(codes(named)).toEqual(['unresolvable-env']);
  });

  it('refuses a set of `resource_sets` that mixes environments', () => {
    const p = preview([
      {
        account_id: 'conn-acme',
        resource_sets: [
          {
            resources: { scope: 'selected', resource_ids: ['res-app-staging', 'res-app-prod'] },
            policy: [readLine],
          },
        ],
      },
    ]);
    expect(codes(p)).toEqual(['resource-set-mixed-env']);
  });

  it('splits a selection given on the account, each set with the lines of its environment', () => {
    const p = preview([
      {
        account_id: 'conn-acme',
        resources: { scope: 'selected', resource_ids: ['res-app-staging', 'res-app-prod'] },
        future: true,
        policy: [readLine, prodLine],
      },
    ]);
    expect(p.ok).toBe(true);
    expect(setsOf(p)).toEqual([
      { ids: ['res-app-staging'], future: true, env: 'staging', risks: ['acme.read'] },
      {
        ids: ['res-app-prod'],
        future: true,
        env: 'prod',
        risks: ['acme.read', 'acme[prod].write'],
      },
    ]);
    expect(p.notices.map((n) => n.code)).toContain('split-by-environment');
  });

  it('refuses an unlabelled resource where the catalog has env-qualified risks, not where the plugin derives it', () => {
    const draft: DraftAccount = {
      account_id: 'conn-acme',
      resources: { scope: 'selected', resource_ids: ['res-scratch'] },
      policy: [readLine],
    };
    expect(codes(preview([draft]))).toEqual(['resource-unlabelled']);
    expect(preview([draft], [acmeAccount({ derives_env: true })]).ok).toBe(true);
  });

  it('refuses two sets taking the future resources of one environment', () => {
    const p = preview([
      {
        account_id: 'conn-acme',
        resource_sets: [
          {
            resources: { scope: 'selected', resource_ids: ['res-app-prod'] },
            future: true,
            policy: [readLine],
          },
          {
            resources: { scope: 'selected', resource_ids: [] },
            future: true,
            env: 'prod',
            policy: [readLine],
          },
        ],
      },
    ]);
    expect(codes(p)).toEqual(['resource-sets-overlap']);
  });

  it('`all` stays the list known now: future off', () => {
    const p = preview([{ account_id: 'conn-acme', trust_levels: { read: 'careful' } }]);
    expect(p.accounts[0]?.future).toBe(false);
    expect(p.resolved[0]?.resource_sets.every((set) => !set.future)).toBe(true);
  });

  it('a normalized draft previews to the same sets (what the edit judges)', () => {
    const context = { accounts: [acmeAccount()], now: NOW };
    const draft = draftOf([
      {
        account_id: 'conn-acme',
        resources: { scope: 'account' },
        policy: [readLine, prodLine],
      },
    ]);
    const normalized = normalizeDraft(context, draft);
    expect(previewDraft(context, normalized.draft).resolved).toEqual(
      previewDraft(context, draft).resolved,
    );
    expect(normalized.notices.map((n) => n.code)).toContain('split-by-environment');
  });
});

describe('previewDraft — resource sets (risk model §4.7)', () => {
  const read = [{ risk_id: 'acme.read', ...BUDGET }];

  it('resolves each set on its own, the set taking the rest without what others select', () => {
    const p = preview([
      {
        account_id: 'conn-acme',
        resource_sets: [
          { resources: { scope: 'all' }, policy: read },
          { resources: { scope: 'selected', resource_refs: ['app-prod'] }, policy: read },
        ],
      },
    ]);
    expect(codes(p)).toEqual([]);
    const sets = p.resolved[0]?.resource_sets ?? [];
    // The rest is the staging resource: `scratch` has no label and is left out.
    expect(sets.map((s) => s.resources)).toEqual([
      { scope: 'selected', resource_ids: ['res-app-staging'] },
      { scope: 'selected', resource_ids: ['res-app-prod'] },
    ]);
    expect(p.accounts[0]?.resource_sets).toHaveLength(2);
  });

  it('refuses a resource in two sets, and two sets taking the rest', () => {
    const twice = preview([
      {
        account_id: 'conn-acme',
        resource_sets: [
          { resources: { scope: 'selected', resource_refs: ['scratch'] }, policy: read },
          { resources: { scope: 'selected', resource_refs: ['scratch'] }, policy: read },
        ],
      },
    ]);
    expect(codes(twice)).toContain('resource-sets-overlap');
    const rests = preview([
      {
        account_id: 'conn-acme',
        resource_sets: [
          { resources: { scope: 'all' }, policy: read },
          { resources: { scope: 'account' }, policy: read },
        ],
      },
    ]);
    expect(rests.ok).toBe(false);
    expect(codes(rests)).toContain('resource-sets-overlap');
  });

  it('refuses sets given beside an account-level policy', () => {
    const p = preview([
      {
        account_id: 'conn-acme',
        policy: read,
        resource_sets: [{ resources: { scope: 'all' }, policy: read }],
      },
    ]);
    expect(codes(p)).toContain('resource-sets-mixed');
  });

  it('judges each set against the authority: a risk outside it is refused in any set', () => {
    const p = preview([
      {
        account_id: 'conn-acme',
        resource_sets: [
          { resources: { scope: 'all' }, policy: read },
          {
            resources: { scope: 'selected', resource_refs: ['app-prod'] },
            policy: [{ risk_id: 'acme.nonexistent', ...BUDGET }],
          },
        ],
      },
    ]);
    expect(p.ok).toBe(false);
  });
});
