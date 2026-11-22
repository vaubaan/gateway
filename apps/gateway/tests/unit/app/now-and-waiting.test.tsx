/**
 * The home ("Now"), "Waiting for you" and the page of one request, rendered to
 * static markup over invented views (no browser, no store): what each page
 * says, in which order, and which answers it offers in which state. How they
 * look is judged by eye; what the read models hold is
 * `tests/integration/now/now.test.ts`.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { FirstRun } from '@/app/(app)/_now/first-run';
import { NowView } from '@/app/(app)/_now/now-view';
import { eventWords } from '@/app/(app)/waiting/event-words';
import { shortTitleOf, titleOf, whoOf } from '@/app/(app)/waiting/parts';
import { RequestView } from '@/app/(app)/waiting/request-view';
import { ToastProvider } from '@/components/ui';
import {
  agoSentence,
  asker,
  delay,
  everyOf,
  limitOf,
  limitReachedOn,
  missionReachedLimit,
  NOW,
  periodNow,
  REQUEST_WORDS,
  until,
  usedOf,
} from '@/lib/vocabulary';
import type { NowView as NowModel, RunningMission, SetupView } from '@/server/now';
import type {
  ApprovalOption,
  ApprovalView,
  ClaimOption,
  ClaimView,
  RequestSummary,
  WaitingItem,
} from '@/server/requests';

vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useRouter: () => ({ refresh: () => undefined }),
}));

const NOW_AT = new Date('2026-10-13T11:02:00.000Z');
const VIEWER = 'user-alice';
const MERGE = 'github.merge-protected';
const READ = 'github.read-code';
const ARGUMENT = 'ARGUMENT-ONLY-ON-THE-REQUEST-PAGE';

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, '')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');

/** The position of each needle in the page, in the order given: they must come in that order. */
function inOrder(html: string, needles: readonly string[]): void {
  let from = 0;
  for (const needle of needles) {
    const at = html.indexOf(needle, from);
    expect(at, `"${needle}" after position ${from}`).toBeGreaterThanOrEqual(0);
    from = at + needle.length;
  }
}

function summary(overrides: Partial<RequestSummary> = {}): RequestSummary {
  return {
    id: 'req-approval',
    kind: 'approval',
    state: 'open',
    risk_id: MERGE,
    risk_label: 'Merge to a protected branch',
    risks: [{ risk_id: MERGE, label: 'Merge to a protected branch' }],
    created_at: '2026-10-13T10:58:00.000Z',
    expires_at: '2026-10-14T10:58:00.000Z',
    decided_at: null,
    decision: null,
    url: 'https://gateway.example.com/r/req-approval',
    mission: { id: 'mission-billing', name: 'Ship the billing page' },
    tool: 'github__merge_pull_request',
    call: {
      tool: 'github__merge_pull_request',
      title: 'Merge a pull request',
      resource: 'acme-org/app',
    },
    ...overrides,
  };
}

const CAROL = {
  token_kind: 'member',
  user_id: 'user-carol',
  holder: 'Carol',
  agent_label: 'codex',
  tool: 'github__merge_pull_request',
  refused_calls: 1,
} as const;

const NIGHTLY = {
  token_kind: 'named',
  user_id: null,
  holder: 'nightly',
  agent_label: null,
  tool: 'github__get_file_contents',
  refused_calls: 5,
} as const;

const PERIOD = {
  index: 0,
  start: '2026-10-13T00:00:00.000Z',
  end: '2026-10-14T00:00:00.000Z',
} as const;

const OPTIONS: readonly ApprovalOption[] = [
  { resolution: 'grant', label: 'x', consequence: 'x', unavailable: null },
  { resolution: 'open-gate', label: 'x', consequence: 'x', unavailable: null },
  { resolution: 'refuse', label: 'x', consequence: 'x', unavailable: null },
];

function approval(overrides: Partial<ApprovalView> = {}): ApprovalView {
  return {
    kind: 'approval',
    request: summary(),
    mission: {
      id: 'mission-billing',
      name: 'Ship the billing page',
      state: 'active',
      expires_at: null,
      period_seconds: 86_400,
    },
    asker: CAROL,
    period: PERIOD,
    call: {
      tool: 'github__merge_pull_request',
      fingerprint: 'a'.repeat(64),
      arguments: { owner: 'acme', repo: 'web', pull_number: 418, note: ARGUMENT },
      arguments_erased: false,
      slices: ['github.repo[acme/web].branch[main].W'],
      risks: [
        {
          risk_id: MERGE,
          resource_set_id: 'set-1',
          label: 'Merge to a protected branch',
          quota: 50,
          consumed: 0,
          remaining: 50,
          gate: 'approval',
        },
      ],
      service_pages: [],
    },
    gate: { policy: 'approval', open_until: null },
    gates: [
      {
        risk_id: MERGE,
        resource_set_id: 'set-1',
        label: 'Merge to a protected branch',
        policy: 'approval',
        open_until: null,
      },
    ],
    approval: null,
    approval_valid_seconds: 600,
    events: [
      {
        id: 'e2',
        at: '2026-10-13T10:58:00.000Z',
        kind: 'call-refused',
        risk_id: MERGE,
        summary: '',
        details: {
          tool: 'github__merge_pull_request',
          fingerprint: 'sha256:abc',
          risk_ids: [MERGE],
          agent_label: 'codex',
          refusal_code: 'approval-required',
          request_id: 'req-approval',
        },
      },
    ],
    options: OPTIONS,
    ...overrides,
  };
}

const CLAIM_OPTIONS: readonly ClaimOption[] = [
  { resolution: 'reset-period', label: 'x', consequence: 'x', unavailable: null },
  { resolution: 'extend-quota', label: 'x', consequence: 'x', unavailable: null, max_amount: 3 },
  {
    resolution: 'extend-expiry',
    label: 'x',
    consequence: 'x',
    unavailable: { code: 'no-expiry', message: 'The mission never expires.' },
  },
  { resolution: 'refuse', label: 'x', consequence: 'x', unavailable: null },
];

function claim(overrides: Partial<ClaimView> = {}): ClaimView {
  return {
    kind: 'claim',
    request: summary({
      id: 'req-claim',
      kind: 'claim',
      risk_id: READ,
      risk_label: 'Read code',
      risks: [{ risk_id: READ, label: 'Read code' }],
      tool: null,
      url: 'https://gateway.example.com/r/req-claim',
      mission: { id: 'mission-audit', name: 'Nightly dependency audit' },
    }),
    mission: {
      id: 'mission-audit',
      name: 'Nightly dependency audit',
      state: 'active',
      expires_at: null,
      period_seconds: 86_400,
    },
    asker: NIGHTLY,
    period: PERIOD,
    risk: {
      risk_id: READ,
      resource_set_id: 'set-1',
      label: 'Read code',
      quota: 5000,
      consumed: 5000,
      remaining: 0,
    },
    other_risks: [
      {
        risk_id: 'github.read-meta',
        resource_set_id: 'set-1',
        label: 'Read metadata',
        quota: 100,
        consumed: 3,
        remaining: 97,
      },
    ],
    events: [],
    options: CLAIM_OPTIONS,
    ...overrides,
  };
}

function page(view: ApprovalView | ClaimView, extra: { decided?: boolean; problem?: string } = {}) {
  return renderToStaticMarkup(
    <RequestView
      view={view}
      viewerId={VIEWER}
      now={NOW_AT}
      rows={{ [MERGE]: 3 }}
      decided={extra.decided ?? false}
      problem={extra.problem ?? null}
    />,
  );
}

// ─────────────────────────────────────────────────────────────────────────────

describe('the words of a limit, a delay and who asks', () => {
  it('names the periods the interface knows, and no other', () => {
    expect(everyOf(86_400)).toBe('day');
    expect(everyOf(604_800)).toBe('week');
    expect(everyOf(3600)).toBe('hour');
    expect(everyOf(12_345)).toBeNull();
    expect(everyOf(null)).toBeNull();
    expect(periodNow(86_400)).toBe('today');
    expect(periodNow(604_800)).toBe('this week');
    expect(periodNow(12_345)).toBe('this period');
    expect(periodNow(null)).toBe('in all');
    expect(limitOf(86_400)).toBe('daily limit');
    expect(limitOf(null)).toBe('limit');
    expect(missionReachedLimit('Nightly audit', 86_400)).toBe(
      'Nightly audit reached its daily limit',
    );
    expect(limitReachedOn('Read code', 604_800)).toBe('Weekly limit reached on Read code');
    expect(limitReachedOn('Read code', null)).toBe('Limit reached on Read code');
    expect(usedOf(5000, 5000)).toBe('5,000 of 5,000');
  });

  it('says how long until an instant and how long ago, short', () => {
    const at = (minutes: number) => new Date(NOW_AT.getTime() + minutes * 60_000);
    expect(until(at(0.5), NOW_AT)).toBe('now');
    expect(until(at(4), NOW_AT)).toBe('in 4 min');
    expect(until(at(13 * 60), NOW_AT)).toBe('in 13 h');
    expect(until(at(30 * 60), NOW_AT)).toBe('tomorrow');
    expect(until(at(4 * 24 * 60), NOW_AT)).toBe('in 4 d');
    // Already past: never a negative figure.
    expect(until(at(-10), NOW_AT)).toBe('now');
    expect(agoSentence(at(-4), NOW_AT)).toBe('4 min ago');
    expect(agoSentence(at(-0.2), NOW_AT)).toBe('just now');
    expect(agoSentence(at(-30 * 60), NOW_AT)).toBe('yesterday');
    expect(delay(600)).toBe('10 minutes');
    expect(delay(90)).toBe('90 seconds');
    expect(delay(7200)).toBe('2 hours');
    expect(delay(60)).toBe('1 minute');
  });

  it('names who asks: a person, the reader, a machine key, or nobody known', () => {
    const base = { holder: null, machine: false, you: false, agent: null };
    // The agent first, then whose key it used: never "You · codex", which reads as if
    // the person were the one asking.
    expect(asker({ ...base, holder: 'Carol', agent: 'codex' })).toBe('codex, with Carol’s key');
    expect(asker({ ...base, holder: 'Alice', you: true, agent: 'codex' })).toBe(
      'codex, with your key',
    );
    expect(asker({ ...base, holder: 'Alice', you: true })).toBe('An agent with your key');
    expect(asker({ ...base, holder: 'nightly', machine: true })).toBe(
      'An agent with the machine key nightly',
    );
    expect(asker({ ...base, machine: true })).toBe('An agent with a machine key');
    expect(asker({ ...base, agent: 'codex' })).toBe('codex');
    expect(asker(base)).toBe('An agent');
    expect(whoOf(CAROL, VIEWER)).toMatchObject({ words: 'codex, with Carol’s key', you: false });
    expect(whoOf({ ...CAROL, user_id: VIEWER }, VIEWER)).toMatchObject({
      words: 'codex, with your key',
    });
    expect(whoOf(NIGHTLY, VIEWER)).toMatchObject({ machine: true, name: 'nightly' });
    expect(whoOf(null, VIEWER)).toMatchObject({ words: 'An agent', name: 'agent' });
  });

  it('counts what the home sums up', () => {
    expect(NOW.nothingNeedsYou(4)).toBe('Nothing needs you. 4 missions are running.');
    expect(NOW.nothingNeedsYou(1)).toBe('Nothing needs you. 1 mission is running.');
    expect(NOW.nothingNeedsYou(0)).toBe('Nothing needs you. No mission is running.');
    expect(NOW.accounts(3, 0)).toBe('3 accounts');
    expect(NOW.accounts(3, 1)).toBe('3 accounts, 1 needs reconnecting');
    expect(NOW.callsLastDay(1212)).toBe('1,212 calls in the last 24 hours');
    expect(REQUEST_WORDS.answeredLastDay(3, 1, 0)).toBe(
      'In the last 24 hours: 3 approved, 1 refused.',
    );
    expect(REQUEST_WORDS.answeredLastDay(0, 0, 0)).toBe('Nothing answered in the last 24 hours.');
  });
});

describe('eventWords', () => {
  const call = {
    tool: 'github__push',
    fingerprint: 'sha256:abc',
    risk_ids: [READ],
    agent_label: 'codex',
  };

  it('words a call with its tool, its code and who made it', () => {
    expect(
      eventWords({ kind: 'call-allowed', details: { ...call, remaining: {}, approval_ids: [] } }),
    ).toMatchObject({ tone: 'ok', call: true, text: 'ran', tool: 'github__push', agent: 'codex' });
    expect(
      eventWords({
        kind: 'call-allowed',
        details: { ...call, remaining: {}, approval_ids: ['a1'] },
      }).text,
    ).toContain('with your yes');
    // A refusal that asks the creator is a call that waits, not one that failed.
    expect(
      eventWords({
        kind: 'call-refused',
        details: { ...call, refusal_code: 'approval-required', request_id: 'r1' },
      }),
    ).toMatchObject({ tone: 'warn', text: 'was stopped on', code: 'approval-required' });
    expect(
      eventWords({
        kind: 'call-refused',
        details: { ...call, refusal_code: 'risk-not-accepted', request_id: null },
      }),
    ).toMatchObject({ tone: 'bad', text: 'was refused', code: 'risk-not-accepted' });
  });

  it('says the acts of the creator as "you", in the words of the interface', () => {
    const span = { period_start: PERIOD.start, period_end: PERIOD.end };
    expect(
      eventWords({ kind: 'reset', details: { request_id: 'r', ...span, credits: {} } }).text,
    ).toBe('You reset the count of this permission');
    expect(
      eventWords({
        kind: 'extension',
        details: { request_id: 'r', dimension: 'quota', amount: 1, ...span, credits: {} },
      }).text,
    ).toBe('You gave back 1 call until the reset');
    expect(
      eventWords({ kind: 'gate-opened', details: { request_id: 'r', ...span } }),
    ).toMatchObject({
      text: 'You let this permission run freely',
      untilWords: 'until',
      until: PERIOD.end,
    });
    expect(
      eventWords({
        kind: 'request',
        details: { request_id: 'r', request_kind: 'approval', tool: 't', fingerprint: 'f' },
      }),
    ).toMatchObject({ tone: 'warn', text: 'Asked you before running', tool: 't' });
    expect(
      eventWords({
        kind: 'request',
        details: { request_id: 'r', request_kind: 'claim', state: 'expired' },
      }).text,
    ).toBe('The request expired without an answer');
    for (const { text: words } of [
      eventWords({ kind: 'reset', details: null }),
      eventWords({ kind: 'approval', details: null }),
      eventWords({ kind: 'gate-changed', details: null }),
    ]) {
      expect(words).not.toMatch(/creator|risk|gate|quota|token|claim/i);
    }
  });

  it('is total: malformed details and a kind a later feature adds', () => {
    expect(eventWords({ kind: 'call-refused', details: { tool: 42 } })).toMatchObject({
      tone: 'bad',
      text: 'A call was refused',
      tool: null,
    });
    expect(eventWords({ kind: 'a-later-kind', details: null })).toMatchObject({
      tone: 'neutral',
      text: 'a-later-kind',
    });
  });
});

describe('the page of an approval', () => {
  it('is read in this order: who, the mission, the call and its arguments, the permission and its row, what an answer does, the answers', () => {
    const html = page(approval());
    inOrder(text(html), [
      'codex',
      'Carol’s key',
      'Ship the billing page',
      'wants to',
      // The head says what the agent wants to do and on what; the permission comes below.
      'Merge a pull request · acme-org/app',
      'Exactly what it sent',
      'github__merge_pull_request',
      'pull_number',
      '418',
      'Permission it needs',
      'ask me first',
      'Merge to a protected branch',
      'Repairable, at a price',
      MERGE,
      'Room left after this',
      '49 of 50 left today',
      'What your answer does',
      'Valid 10 minutes, for exactly this call',
      'Approve this call',
      'What led here',
      'What the agent sees meanwhile',
    ]);
    // The row is a word, and the consequence is stated before the first button.
    inOrder(html, ['data-row="3"', 'Valid 10 minutes', 'name="resolution" value="grant"']);
    // The arguments as they were sent, each by its name.
    expect(html).toContain(ARGUMENT);
    expect(text(html)).toContain('repoweb');
  });

  it('offers every answer the service accepts, each with what it does, the yes first', () => {
    const html = page(approval());
    const forms = html.match(/action="\/api\/requests\/req-approval\/decide"/g) ?? [];
    expect(forms).toHaveLength(3);
    inOrder(html, [
      'name="resolution" value="grant"',
      'name="resolution" value="refuse"',
      'name="resolution" value="open-gate"',
    ]);
    expect(text(html)).toContain('Nothing runs. If the agent retries');
    expect(text(html)).toContain('runs without asking you until');
    expect(html).not.toContain('disabled=""');
    // The refusal the agent holds, as the protocol spells it.
    expect(text(html)).toContain('"approval-required"');
    expect(text(html)).toContain('https://gateway.example.com/r/req-approval');
  });

  it('says one answer covers the call when it needs several permissions, and what is left of each', () => {
    const second = {
      risk_id: 'github.workflow-edit',
      resource_set_id: 'set-1',
      label: 'Edit a workflow',
    };
    const html = page(
      approval({
        request: summary({ risks: [...summary().risks, second] }),
        gates: [...approval().gates, { ...second, policy: 'approval', open_until: null }],
        call: {
          ...approval().call,
          risks: [
            ...approval().call.risks,
            { ...second, quota: 10, consumed: 10, remaining: 0, gate: 'approval' },
          ],
        },
      }),
    );
    // One head for the call, then each permission it needs.
    expect(text(html)).toContain('Merge a pull request · acme-org/app');
    inOrder(text(html), ['Permissions it needs', 'Merge to a protected branch', 'Edit a workflow']);
    expect(text(html)).toContain('one answer for the 2');
    expect(text(html)).toContain('One yes covers the 2 permissions this call needs.');
    // A limit already reached is said before the person answers.
    expect(text(html)).toContain('the call would be refused even with your yes');
  });

  it('answered: says what became of it, shows no answer and no argument', () => {
    const html = page(
      approval({
        request: summary({
          state: 'granted',
          decided_at: '2026-10-13T11:00:00.000Z',
          decision: { resolution: 'grant' },
        }),
        call: { ...approval().call, arguments: null, arguments_erased: true },
        approval: {
          id: 'a1',
          expires_at: '2026-10-13T11:10:00.000Z',
          consumed_at: '2026-10-13T11:01:00.000Z',
          state: 'consumed',
        },
        options: [],
      }),
      { decided: true },
    );
    expect(html).not.toContain('<form');
    expect(html).not.toContain(ARGUMENT);
    expect(text(html)).toContain('approved');
    expect(text(html)).toContain('You approved this call 2 min ago.');
    expect(text(html)).toContain('The agent ran it on');
    expect(text(html)).toContain('only their fingerprint remains');
    expect(text(html)).toContain('Answer recorded');
    // What the agent sees meanwhile is said while the request waits, not after.
    expect(text(html)).not.toContain('What the agent sees meanwhile');
    expect(text(html)).toContain('Room left now');
  });

  it('expired and refused have a state of their own', () => {
    const expired = page(approval({ request: summary({ state: 'expired' }), options: [] }));
    expect(text(expired)).toContain('the request expired and nothing ran');
    expect(expired).not.toContain('<form');
    const refused = page(
      approval({
        request: summary({
          state: 'refused',
          decided_at: '2026-10-13T11:01:00.000Z',
          decision: { resolution: 'refuse' },
        }),
        options: [],
      }),
    );
    expect(text(refused)).toContain('You refused 1 min ago. Nothing ran.');
  });

  it('on a mission that cannot run, says why and leaves only the answer that applies', () => {
    const closed = { code: 'mission-closed', message: 'server words' } as const;
    const html = page(
      approval({
        mission: { ...approval().mission, state: 'revoked' },
        options: [
          { ...OPTIONS[0]!, unavailable: closed },
          { ...OPTIONS[1]!, unavailable: closed },
          OPTIONS[2]!,
        ],
      }),
    );
    expect(text(html)).toContain('This mission cannot run');
    expect(text(html)).toContain('Not possible now: the mission was stopped.');
    expect(html.match(/disabled=""/g)).toHaveLength(2);
    // The words of the server are not the page's.
    expect(html).not.toContain('server words');
  });

  it('says why the last answer was not taken, by its code', () => {
    expect(text(page(approval(), { problem: 'gate-not-closed' }))).toContain(
      'This permission already runs freely',
    );
    expect(text(page(approval(), { problem: 'unknown-code' }))).toContain(
      'The answer was not taken.',
    );
  });

  it('names an agent nobody identified, and the reader’s own key', () => {
    expect(text(page(approval({ asker: null })))).toContain(
      'An agent on Ship the billing page wants to',
    );
    expect(text(page(approval({ asker: { ...CAROL, user_id: VIEWER } })))).toContain(
      'codex using your key',
    );
  });
});

describe('the page of a limit that was reached', () => {
  it('says who was stopped, on what, how much was used, and when it resets by itself', () => {
    const html = page(claim());
    inOrder(text(html), [
      'An agent using the machine key nightly',
      'Nightly dependency audit',
      'reached a limit',
      'Read code',
      '5,000 of 5,000 today',
      'Stopped on',
      'github__get_file_contents',
      '5 calls since; nothing ran',
      '5,000 a day',
      'resets',
      '(in 12 h)',
      'What your answer does',
    ]);
  });

  it('offers the ways of answering as one choice, without the one that does not apply', () => {
    const html = page(claim());
    expect(html).toContain('data-testid="answer-reset-period"');
    expect(html).toContain('data-testid="answer-extend-quota"');
    expect(html).toContain('data-testid="answer-refuse"');
    // A mission with no end date has nothing to extend.
    expect(html).not.toContain('data-testid="answer-extend-expiry"');
    expect(text(html)).toContain('Leave it until the reset');
    expect(text(html)).toContain('The limit stays at 5,000');
    // One form, and only the fields of the chosen answer are sent.
    expect(html.match(/<form/g)).toHaveLength(1);
    expect(html).toContain('name="resolution" value="reset-period"');
    expect(html).not.toContain('name="amount"');
    const form = /<form[\s\S]*?<\/form>/.exec(html)?.[0] ?? '';
    // The endpoint refuses a field it does not expect: the form holds the answer and nothing else.
    expect([...form.matchAll(/ name="([^"]+)"/g)].map((match) => match[1])).toEqual(['resolution']);
  });

  it('answered or expired: what became of it, and no choice', () => {
    const given = page(
      claim({
        request: {
          ...claim().request,
          state: 'granted',
          decided_at: '2026-10-13T11:00:00.000Z',
          decision: { resolution: 'extend-quota', amount: 2 },
        },
        options: [],
      }),
    );
    expect(text(given)).toContain('You gave back 2 calls 2 min ago.');
    expect(given).not.toContain('<form');
    const left = page(
      claim({
        request: {
          ...claim().request,
          state: 'refused',
          decided_at: '2026-10-13T11:00:00.000Z',
          decision: { resolution: 'refuse' },
        },
        options: [],
      }),
    );
    expect(text(left)).toContain('You left it 2 min ago');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

function waitingItem(view: ApprovalView | ClaimView): WaitingItem {
  return {
    request: view.request,
    asker: view.asker,
    budget:
      view.kind === 'claim'
        ? view.risk
          ? [view.risk]
          : []
        : view.call.risks.map(({ gate: _gate, ...line }) => line),
    period: PERIOD,
    period_seconds: 86_400,
  };
}

function running(overrides: Partial<RunningMission> = {}): RunningMission {
  return {
    id: 'mission-billing',
    name: 'Ship the billing page',
    role: 'creator',
    creator: null,
    services: ['GitHub', 'Supabase'],
    holders: [
      { kind: 'member', label: 'Alice', you: true },
      { kind: 'member', label: 'Carol', you: false },
      { kind: 'named', label: 'nightly', you: false },
    ],
    issued_via: null,
    nearest: { risk_id: 'github.write', label: 'branch writes', used: 1860, limit: 3000 },
    limits_reached: 0,
    open_requests: 0,
    last_activity_at: '2026-10-13T11:00:00.000Z',
    created_at: '2026-10-01T00:00:00.000Z',
    calls_last_day: 327,
    ...overrides,
  };
}

function model(overrides: Partial<NowModel> = {}): NowModel {
  return {
    at: NOW_AT.toISOString(),
    waiting: [],
    running: [],
    stopped: [],
    totals: {
      missions: 0,
      stopped: 0,
      calls_last_day: 0,
      refused_last_hour: 0,
      accounts: 0,
      accounts_to_reconnect: 0,
    },
    first_run: false,
    shared_accounts: [],
    shared_missions: [],
    trust_raises: [],
    ...overrides,
  };
}

describe('the home, when something waits', () => {
  const view = model({
    waiting: [waitingItem(claim()), waitingItem(approval())],
    running: [
      running(),
      running({
        id: 'mission-audit',
        name: 'Nightly dependency audit',
        limits_reached: 1,
        holders: [{ kind: 'named', label: 'nightly', you: false }],
      }),
    ],
    stopped: [
      { id: 'm-old', name: 'Migration dry-run', role: 'creator', state: 'expired', since: null },
    ],
    totals: {
      missions: 3,
      stopped: 1,
      calls_last_day: 1212,
      refused_last_hour: 3,
      accounts: 3,
      accounts_to_reconnect: 1,
    },
  });
  const html = renderToStaticMarkup(<NowView view={view} viewerId={VIEWER} />);

  it('is one page: what waits, then what runs, then the counts — one h1, one primary action', () => {
    expect(html.match(/<h1/g)).toHaveLength(1);
    inOrder(text(html), [
      'Now',
      'Waiting for you',
      'Only you can answer',
      'Nightly dependency audit reached its daily limit',
      'Merge to a protected branch',
      'Running now',
      'Ship the billing page',
      'Not running',
      'Migration dry-run',
      '1,212 calls in the last 24 hours',
      '3 refused in the last hour',
      '3 accounts, 1 needs reconnecting',
    ]);
    expect(html.match(/data-variant="primary"/g)).toHaveLength(1);
  });

  it('never gives a yes from here: an approval leads to its request, a refusal may be given at once', () => {
    expect(html).toContain('href="/waiting/req-approval"');
    expect(html).toContain('href="/waiting/req-claim"');
    expect(html).not.toContain('value="grant"');
    expect(html).not.toContain('value="open-gate"');
    expect(html.match(/name="resolution" value="refuse"/g)).toHaveLength(1);
    // And nothing of the arguments of a call.
    expect(html).not.toContain(ARGUMENT);
  });

  it('heads an approval with what the agent wants to do, then who asks, the permission and what is left', () => {
    inOrder(text(html), [
      'Merge a pull request · acme-org/app',
      'codex, with Carol’s key, on Ship the billing page',
      'needs “Merge to a protected branch”',
      'you asked to be asked first',
      '50 of 50 left today',
    ]);
    // The head is the plugin's title of the tool, not the name of the permission.
    expect(html).toMatch(
      /data-testid="call-headline"[^>]*>Merge a pull request[^<]*<span class="vbn-nowrap">acme-org\/app/,
    );
    expect(text(html)).toContain('5,000 of 5,000');
    expect(text(html)).toContain('An agent with the machine key nightly · stopped on it');
  });

  it('draws one figure per mission: a meter near a limit, the exception in words', () => {
    expect(html.match(/role="meter"/g)).toHaveLength(1);
    expect(text(html)).toContain('62% branch writes');
    expect(text(html)).toContain('Limit reached');
    expect(text(html)).toContain('GitHub · Supabase · you, Carol, machine key nightly');
  });
});

describe('the home, when nothing waits', () => {
  it('is one sentence and where to go; what runs is one click away', () => {
    const html = renderToStaticMarkup(
      <NowView
        view={model({
          running: [running({ nearest: null })],
          totals: { ...model().totals, missions: 1, accounts: 2 },
        })}
        viewerId={VIEWER}
      />,
    );
    expect(text(html)).toContain('Nothing needs you. 1 mission is running.');
    expect(html).not.toContain('Waiting for you');
    expect(text(html)).toContain('Show what is running');
    // The list is in the page, closed until asked for.
    expect(html).toMatch(/hidden=""[^>]*>[\s\S]*Running now/);
    // "New mission" is the primary action when nothing waits.
    expect(html.match(/data-variant="primary"/g)).toHaveLength(1);
    expect(html).toContain('href="/missions/new"');
  });

  it('a teammate reads that a mission shared with them waits for its creator', () => {
    const html = renderToStaticMarkup(
      <NowView
        view={model({
          waiting: [waitingItem(approval())],
          running: [running({ role: 'member', creator: 'Alice', open_requests: 1 })],
          totals: { ...model().totals, missions: 1 },
        })}
        viewerId={VIEWER}
      />,
    );
    expect(text(html)).toContain('waiting for Alice’s yes');
    expect(text(html)).toContain('shared by Alice');
  });
});

describe('the first run', () => {
  const setup: SetupView = {
    sign_in: 'login.acme.example',
    telemetry: { enabled: false, decided: false },
  };

  it('explains the model and leads to the first account, then the first mission', () => {
    const html = renderToStaticMarkup(
      <FirstRun view={model({ first_run: true })} name="Carol" setup={null} />,
    );
    inOrder(text(html), [
      'Welcome, Carol',
      'without ever holding a credential',
      'Account',
      'Mission',
      'Key',
      'Agent',
      'Activity',
      'Get started',
      'Connect an account',
      'Give an agent a mission',
      'Paste the kit into your agent',
    ]);
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html.match(/data-variant="primary"/g)).toHaveLength(1);
    expect(html).toContain('href="/accounts/new"');
    // No mission can be created before an account exists: the step offers nothing yet.
    expect(html).not.toContain('href="/missions/new"');
  });

  it('with an account someone gave access to, the next step is the mission', () => {
    const html = renderToStaticMarkup(
      <FirstRun
        view={model({
          first_run: true,
          shared_accounts: [
            {
              account_id: 'c1',
              name: 'acme',
              service: 'GitHub',
              owner: 'Bob',
              permissions: 12,
            },
          ],
          shared_missions: [
            {
              id: 'm1',
              name: 'Ship the billing page',
              creator: 'Alice',
              services: ['GitHub'],
              has_key: false,
              running: true,
            },
          ],
        })}
        name={null}
        setup={null}
      />,
    );
    expect(text(html)).toContain('Welcome');
    expect(text(html)).toContain('An account you can use');
    expect(text(html)).toContain('Bob gave you access to GitHub · acme (12 permissions)');
    expect(html.match(/data-variant="primary"/g)).toHaveLength(1);
    expect(html).toMatch(
      /data-variant="primary"[^>]*href="\/missions\/new"|href="\/missions\/new"[^>]*data-variant="primary"/,
    );
    expect(text(html)).toContain('Shared with you');
    expect(text(html)).toContain('Get my key');
    expect(text(html)).toContain('Alice never sees it');
  });

  it('an administrator also reads what is left to set up, and an open step takes the accent', () => {
    const html = renderToStaticMarkup(
      <FirstRun view={model({ first_run: true })} name="Dan" setup={setup} />,
    );
    inOrder(text(html), [
      'Set up this gateway',
      'Sign-in through login.acme.example',
      'Telemetry',
      'Then, like everyone',
      'Connect an account',
    ]);
    // No service asks an administrator to declare anything (ADR gmail-over-imap-with-an-app-password).
    expect(text(html)).not.toContain('OAuth client');
    expect(html.match(/data-variant="primary"/g)).toHaveLength(1);

    const open = renderToStaticMarkup(
      <FirstRun view={model({ first_run: true })} name="Dan" setup={{ ...setup, sign_in: null }} />,
    );
    expect(open.match(/data-variant="primary"/g)).toHaveLength(1);
    expect(text(open)).toContain('Set up sign-in');
  });
});

describe('the titles of what waits', () => {
  const rendered = (node: React.ReactNode) => text(renderToStaticMarkup(<>{node}</>));

  it('an approval is named by what the agent wants to do, a limit by its mission and its period', () => {
    expect(rendered(titleOf(waitingItem(approval())))).toBe('Merge a pull request · acme-org/app');
    expect(rendered(shortTitleOf(waitingItem(approval())))).toBe(
      'Merge a pull request · acme-org/app',
    );
    expect(titleOf(waitingItem(claim()))).toBe('Nightly dependency audit reached its daily limit');
    expect(shortTitleOf(waitingItem(claim()))).toBe('Daily limit reached on Read code');
  });

  it('a tool without a title is named as the protocol spells it; a call without a resource names none', () => {
    const untitled = waitingItem(
      approval({
        request: summary({
          call: { tool: 'github__merge_pull_request', title: null, resource: null },
        }),
      }),
    );
    const html = renderToStaticMarkup(<>{titleOf(untitled)}</>);
    expect(text(html)).toBe('github__merge_pull_request');
    // In mono: an id a person may need to quote.
    expect(html).toMatch(/<code[^>]*>github__merge_pull_request<\/code>|class="[^"]*mono/i);
  });

  it('a request recorded without its call falls back on the permission', () => {
    const item = waitingItem(approval({ request: summary({ call: null }) }));
    expect(titleOf(item)).toBe('Merge to a protected branch');
  });
});

describe('the home, with a trust-raise proposal (risk model §4.7)', () => {
  const offer = {
    account_id: 'conn-gh',
    account_name: 'GitHub main',
    resource_set_id: 'set-2',
    resource_set_position: 2,
    several_sets: true,
    macro_action_id: 'change',
    macro_action_label: 'Change',
    from: 'trusting' as const,
    to: 'autonomous' as const,
    approvals: 10,
  };
  const html = renderToStaticMarkup(
    <ToastProvider>
      <NowView
        view={model({
          trust_raises: [{ mission_id: 'm-1', mission_name: 'Ship it', offers: [offer] }],
        })}
        viewerId={VIEWER}
      />
    </ToastProvider>,
  );

  it('offers the raise by one level, says why and where, and opens the edit there', () => {
    const words = text(html);
    expect(words).toContain('Ship it: Raise “Change” to Autonomous?');
    expect(words).toContain(
      'You approved it 10 times on GitHub main, resource set 2, with no refusal since it was set to Trusting.',
    );
    expect(html).toContain('href="/missions/m-1/edit?raise=set-2&amp;action=change"');
    expect(words).toContain('Not now');
  });

  it('keeps one primary action on the page', () => {
    expect(html.match(/data-variant="primary"/g)?.length ?? 0).toBeLessThanOrEqual(1);
  });
});
