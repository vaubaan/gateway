/**
 * The generated references of the docs (website spec §2.2), each built from
 * the source that owns its facts, never written by hand:
 *
 * - `/docs/reference/refusals` — the refusal codes (`REFUSAL_CODES` of
 *   `@vaubaan/shared`), what happened and what the agent does (the table of
 *   the agent bootstrap every instance serves), the fields and the hint of
 *   each (the builders of `@vaubaan/gateway-core`), and what the person does
 *   (`PERSON_NEXT`, the one part written here, keyed by code so a new code
 *   fails to compile until it has its sentence);
 * - `/docs/reference/trust-levels` — the rows by trust level, from the
 *   policy engine (`TRUST_LEVEL_GATES`, `ROW_WORDS`, the reasons and the
 *   budget factors);
 * - `/docs/reference/words` — the interface's words and the protocol's, from
 *   the vocabulary table of the gateway spec (§0), its normative home;
 * - `/docs/reference/for-agents` — the agent bootstrap itself, as every
 *   instance serves it at `/agent-bootstrap.md`.
 *
 * A source whose shape changes makes the reader throw: the build fails
 * rather than publish a page that lost a row.
 */
import {
  AUTH_FAILURE_REASONS,
  AUTH_REQUIRED_HTTP_STATUS,
  AUTH_REQUIRED_RPC_CODE,
  REFUSAL_RPC_CODE,
  refusalToRpcError,
  refuse,
  type AuthFailureReason,
  type Refusal,
} from '@vaubaan/gateway-core';
import {
  GATE_WORDS,
  gateWordOf,
  REASON_WORDS,
  REASONS,
  ROW_OF_REASON,
  ROW_WORDS,
  TREE_LEGEND,
  TRUST_LEVEL_BUDGET_FACTOR,
  TRUST_LEVEL_GATES,
  TRUST_LEVEL_HINTS,
  TRUST_LEVEL_LABELS,
  TRUST_LEVELS,
  type Row,
} from '@vaubaan/policy-engine';
import { REFUSAL_CODES, type RefusalCode } from '@vaubaan/shared';

import { cellsOf, markdownTable, rewriteRelativeLinks, sectionsOf, splitTitle } from './markdown';
import { readRepoFile } from './repo';

/** The agent bootstrap, served by every instance at `/agent-bootstrap.md`. */
export const AGENT_BOOTSTRAP = 'apps/gateway/src/app/agent-bootstrap.md/content.md';
/** Its section on refusals: the table of codes, then the table of the 401 reasons. */
export const BOOTSTRAP_REFUSALS_SECTION = '5. When a call is refused';
export const ERRORS_SOURCE = 'packages/gateway-core/src/errors.ts';
export const GATEWAY_SPEC = 'docs/spec/vaubaan-gateway.md';
export const VOCABULARY_SECTION = '0. Vocabulary';
const RISK_MODEL = 'docs/spec/gateway-risk-model.md';

/** A generated docs page before it is framed (`build-site.ts` adds the title and the MDX file). */
export interface ReferenceDoc {
  /** Where its MDX file goes, from `content/docs`. */
  readonly file: string;
  readonly path: string;
  readonly title: string;
  readonly description: string;
  readonly body: string;
  readonly sources: readonly string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Refusals
// ─────────────────────────────────────────────────────────────────────────────

/** One row of a bootstrap table: the code (or reason), what happened, what the agent does. */
export interface BootstrapRow {
  readonly code: string;
  readonly happened: string;
  readonly agentDoes: string;
}

/** The tables of a Markdown text, each as its rows of cells (header and rule left out). */
function tablesOf(markdown: string): string[][][] {
  const tables: string[][][] = [];
  let current: string[] | null = null;
  for (const line of [...markdown.split('\n'), '']) {
    if (line.startsWith('|')) (current ??= []).push(line);
    else if (current) {
      tables.push(current.slice(2).map(cellsOf));
      current = null;
    }
  }
  return tables;
}

function rowsOf(table: string[][] | undefined, what: string): BootstrapRow[] {
  if (!table) throw new Error(`${AGENT_BOOTSTRAP}: no table of ${what} in §5`);
  return table.map(([code = '', happened = '', agentDoes = '']) => ({
    code: code.replace(/`/g, '').trim(),
    happened,
    agentDoes,
  }));
}

/**
 * The two tables of the bootstrap's §5: the refusal codes, and the reasons of a
 * 401 for a key that stopped working. Throws when the section or a table is gone.
 */
export function parseBootstrapRefusals(bootstrap: string): {
  readonly refusals: BootstrapRow[];
  readonly authFailures: BootstrapRow[];
} {
  const section = sectionsOf(bootstrap).find((s) => s.heading === BOOTSTRAP_REFUSALS_SECTION);
  if (!section) throw new Error(`${AGENT_BOOTSTRAP}: no "## ${BOOTSTRAP_REFUSALS_SECTION}"`);
  const [codes, reasons] = tablesOf(section.text);
  return {
    refusals: rowsOf(codes, 'refusal codes'),
    authFailures: rowsOf(reasons, '401 reasons'),
  };
}

/** What the person does next, per code: the only part of the page written here. */
export const PERSON_NEXT: Readonly<Record<RefusalCode, string>> = {
  'risk-not-accepted':
    'Nothing waits for you unless the agent asks: when it asks for the missing permission, the request is under **Waiting for you**, where you add it or refuse. To give it yourself, **Edit mission** and tick it. Add it only if the task needs it.',
  'budget-exhausted':
    'Open the link, or **Waiting for you**: give more for this period or reset the limit, or let the period end. A one-off mission has no next period, so only your answer reopens it.',
  'approval-required':
    'Open the link, or **Waiting for you**: the request shows the exact call. Approve it or refuse it; unanswered, it closes when it expires. An approval is used once, for that call with those arguments.',
  'resource-not-in-mission':
    'If the task needs that resource, **Edit mission** and select it: the agent keeps its key and its next call reaches it. A resource created outside the gateway reaches a mission that takes "the resources found later" once discovery finds it.',
  'rate-limited':
    'Nothing, usually: the agent waits and retries. If the per-minute limit is too low for the task, raise it under **Edit mission**, **Advanced**.',
  'account-unavailable':
    "The account's owner opens it under **Accounts** and reconnects it. Its missions work again with the keys they have.",
  'account-revoked':
    "Removed for good (`final: true`): create a mission for the account that replaces it. Your access withdrawn (`final: false`): ask the account's owner to give it back, and the same key works on it again.",
  'mission-inactive':
    'Expired: only its creator can extend it. Stopped (`revoked`): it never runs again; duplicate it into a new mission. Without an owner (`orphaned`): give back the access it was built on, and it serves calls again with the same keys.',
  'wrong-credential-kind':
    "Give the agent the mission's key from the setup kit, and point it at the instance's `/mcp`. Your browser session never opens that door.",
};

const EXAMPLE_ACCOUNT = { id: 'acc_01', name: 'acme-supabase' };

/**
 * One refusal per code, from the gateway's own builders, with the two worked
 * projects' permissions. `risk-not-accepted` takes its hint from the policy
 * engine (`evaluateCall`), so its example hint is left out.
 */
const EXAMPLES: Readonly<Record<RefusalCode, Refusal>> = {
  'risk-not-accepted': refuse.riskNotAccepted({
    missing_risks: ['github.merge-protected'],
    executed_slices: [],
    hint: '',
  }),
  'budget-exhausted': refuse.budgetExhausted({
    risk_id: 'gmail.draft-write',
    quota: 20,
    consumed: 20,
    period_end: '2026-11-21T00:00:00Z',
    claim_url: 'https://your-domain/requests/req_01',
  }),
  'approval-required': refuse.approvalRequired({
    risk_id: 'supabase[prod].migration-write',
    fingerprint: 'sha256:3f9a…',
    approval_url: 'https://your-domain/requests/req_02',
    expires_at: '2026-11-20T18:00:00Z',
    approval_valid_seconds: 600,
  }),
  'resource-not-in-mission': refuse.resourceNotInMission({
    cited_ref: 'acme/billing',
    account: { id: 'acc_02', name: 'acme' },
    allowed_resources: [{ ref: 'acme/web', env: null, display_name: null }],
  }),
  'rate-limited': refuse.rateLimited({
    risk_id: 'notion.content-append',
    limit: { max: 10, window_seconds: 60 },
    retry_after_seconds: 12,
  }),
  'account-unavailable': refuse.accountUnavailable({
    account: { id: 'acc_03', name: 'me@example.com' },
    status: 'expired',
    owner: { kind: 'user', display: 'me@example.com' },
  }),
  'account-revoked': refuse.accountRevoked({ account: EXAMPLE_ACCOUNT, cause: 'access-withdrawn' }),
  'mission-inactive': refuse.missionInactive({ status: 'expired', reason: 'its end date passed' }),
  'wrong-credential-kind': refuse.wrongCredentialKind({
    door: 'execution',
    presented: 'human-session',
    expected: 'mission-token',
  }),
};

/** The example refusal of a code, as the gateway builds it. */
export function exampleRefusal(code: RefusalCode): Refusal {
  return EXAMPLES[code];
}

/** The fields a refusal of `code` carries besides `code` and `hint`. */
export function refusalFields(code: RefusalCode): string[] {
  return Object.keys(exampleRefusal(code)).filter((key) => key !== 'code' && key !== 'hint');
}

function byCode(rows: readonly BootstrapRow[], codes: readonly string[], what: string) {
  const found = new Map(rows.map((row) => [row.code, row]));
  const missing = codes.filter((c) => !found.has(c));
  const extra = rows.map((r) => r.code).filter((c) => !codes.includes(c));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `${AGENT_BOOTSTRAP} §5: the ${what} table differs from the gateway's (missing: ${missing.join(', ') || 'none'}; unknown: ${extra.join(', ') || 'none'})`,
    );
  }
  return (code: string): BootstrapRow => found.get(code) as BootstrapRow;
}

/** The page's Markdown, from the bootstrap's text. */
export function refusalsMarkdown(bootstrap: string): string {
  const { refusals, authFailures } = parseBootstrapRefusals(bootstrap);
  const refusal = byCode(refusals, REFUSAL_CODES, 'refusal codes');
  const reason = byCode(authFailures, AUTH_FAILURE_REASONS, '401 reasons');
  const sample = exampleRefusal('approval-required');
  const rpc = refusalToRpcError(1, sample);

  const out: string[] = [
    `A refusal is how Vaubaan Gateway answers a call it will not run: a JSON-RPC error with code \`${REFUSAL_RPC_CODE}\` whose \`data\` carries the refusal's \`code\`, the fields of that code and a \`hint\` telling the agent what to do. Nothing was executed and nothing is held: the gateway never keeps a call waiting.`,
    '',
    "This page lists every code with what the agent does and what you, the person behind the mission, do next. It is generated from the gateway: the codes and fields from its builders, the agent's side from the [reference for agents](/docs/reference/for-agents) every instance serves.",
    '',
    markdownTable(
      ['Code', 'What happened'],
      REFUSAL_CODES.map((code) => [`[\`${code}\`](#${code})`, refusal(code).happened]),
    ),
    '',
    'A refusal as the agent receives it:',
    '',
    '```json',
    JSON.stringify(rpc, null, 2),
    '```',
    '',
    "**The agent never works around a refusal**: no other tool, no other key, no direct access to the service, no splitting an action to slip under a limit. A link in a refusal (`claim_url`, `approval_url`) is for you: only the mission's creator, signed in, can answer it, and the same request is under **Waiting for you**.",
  ];
  for (const code of REFUSAL_CODES) {
    const row = refusal(code);
    const example = exampleRefusal(code);
    out.push(
      '',
      `## \`${code}\``,
      '',
      `**What happened.** ${row.happened}`,
      '',
      `**What the agent does.** ${row.agentDoes}`,
      '',
      `**What you do.** ${PERSON_NEXT[code]}`,
      '',
      `**Fields**: ${['code', ...refusalFields(code), 'hint'].map((f) => `\`${f}\``).join(', ')}.`,
    );
    if (example.hint !== '') {
      out.push('', 'Example hint:', '', `> ${example.hint}`);
    }
  }
  out.push(
    '',
    '## When the key itself stops working',
    '',
    `An HTTP ${AUTH_REQUIRED_HTTP_STATUS} with JSON-RPC code \`${AUTH_REQUIRED_RPC_CODE}\` is not a refusal: the key is unknown or malformed. When \`error.data.reason\` is set, the key authenticated before and no longer does; the mission may still be running for its other holders.`,
    '',
    markdownTable(
      ['Reason', 'What happened', 'What the agent does'],
      AUTH_FAILURE_REASONS.map((r: AuthFailureReason) => [
        `\`${r}\``,
        reason(r).happened,
        reason(r).agentDoes,
      ]),
    ),
  );
  return out.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Rows by trust level
// ─────────────────────────────────────────────────────────────────────────────

/** The rows, hardest to repair first, as the interface lists them. */
const ROWS_WORST_FIRST: readonly Row[] = [4, 3, 2, 1];

function gateCell(row: Row, level: (typeof TRUST_LEVELS)[number]): string {
  const gate = TRUST_LEVEL_GATES[level][row];
  return gate === null ? GATE_WORDS.off : `${GATE_WORDS[gateWordOf(gate)]} (\`${gate}\`)`;
}

export function trustLevelsMarkdown(): string {
  const levels = TRUST_LEVELS.map((level) => TRUST_LEVEL_LABELS[level]);
  return [
    "A trust level is what a person sets a ticked macro-action to when creating a mission; from the row of each permission, it decides whether that permission runs freely, asks first or is left out, and it multiplies the limits. This page is generated from the gateway's policy engine; why the model works this way is explained in [how a permission is decided](/docs/concepts/permissions).",
    '',
    '## The matrix',
    '',
    markdownTable(
      ['Row', ...levels],
      ROWS_WORST_FIRST.map((row) => [
        `${row}. ${ROW_WORDS[row]}`,
        ...TRUST_LEVELS.map((level) => gateCell(row, level)),
      ]),
    ),
    '',
    'It only pre-fills the mission: every line stays editable before the mission is created, and the mission stores the explicit list of permissions, never the trust level.',
    '',
    '## The levels',
    '',
    markdownTable(
      ['Trust level', 'What it does', 'Limits'],
      TRUST_LEVELS.map((level) => [
        TRUST_LEVEL_LABELS[level],
        TRUST_LEVEL_HINTS[level],
        `×${TRUST_LEVEL_BUDGET_FACTOR[level]}`,
      ]),
    ),
    '',
    "The limits are the macro-action's base limits (per period and per minute) multiplied; the per-minute rate stays under the ceiling the service's catalog declares for the permission.",
    '',
    '## How a permission gets its row',
    '',
    `${TREE_LEGEND} The first reason that answers is the one shown beside the permission.`,
    '',
    markdownTable(
      ['Reason', 'Row'],
      REASONS.map((reason) => [
        REASON_WORDS[reason],
        `${ROW_OF_REASON[reason]}. ${ROW_WORDS[ROW_OF_REASON[reason]]}`,
      ]),
    ),
    '',
    `The model, normative: [gateway-risk-model §4.6](https://github.com/vaubaan/gateway/blob/main/${RISK_MODEL}#46-macro-actions-and-trust-levels).`,
  ].join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Words
// ─────────────────────────────────────────────────────────────────────────────

export interface Vocabulary {
  /** The words the interface, the code and the protocol share. */
  readonly same: readonly string[];
  /** Interface word → protocol word, as spec §0 pairs them. */
  readonly pairs: readonly (readonly [string, string])[];
}

/** The vocabulary of the gateway spec, §0: its shared words and its two-column table. */
export function parseVocabulary(spec: string): Vocabulary {
  const section = sectionsOf(spec).find((s) => s.heading === VOCABULARY_SECTION);
  if (!section) throw new Error(`${GATEWAY_SPEC}: no "## ${VOCABULARY_SECTION}"`);
  const same = [...section.text.matchAll(/^- \*\*([a-z]+)\*\* — /gm)].map((m) => m[1] ?? '');
  const [table] = tablesOf(section.text);
  if (same.length === 0 || !table || table.some((row) => row.length !== 2)) {
    throw new Error(`${GATEWAY_SPEC} §0: the vocabulary changed shape; update the site's reader`);
  }
  return { same, pairs: table.map(([a = '', b = '']) => [a, b] as const) };
}

export function wordsMarkdown(spec: string): string {
  const { same, pairs } = parseVocabulary(spec);
  return [
    `The words of Vaubaan Gateway come in two sets: the interface speaks to people, the protocol to agents and code. ${same.map((w) => `**${w}**`).join(', ')} are the same in both; for the others, tool names, refusal codes, permission ids, API fields and configuration keys keep the protocol's word.`,
    '',
    'Use the first column when you talk to a person and the second when you read or write JSON. What each word means: [concepts](/docs/concepts).',
    '',
    markdownTable(['In the interface', 'In the protocol, the code and the spec'], pairs),
    '',
    `Generated from the vocabulary of the [gateway spec](https://github.com/vaubaan/gateway/blob/main/${GATEWAY_SPEC}#0-vocabulary), its normative home.`,
  ].join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// For agents
// ─────────────────────────────────────────────────────────────────────────────

export function forAgentsMarkdown(bootstrap: string): string {
  const { rest } = splitTitle(bootstrap);
  return [
    'This page is the reference an agent holding a mission key works from: how to reach an instance, what a mission lets it do, what each refusal means and how to propose a mission. Every instance serves the same text at `/agent-bootstrap.md`; an agent can fetch it there, or here as Markdown at `/docs/reference/for-agents.md`.',
    '',
    rewriteRelativeLinks(rest.trim(), AGENT_BOOTSTRAP),
  ].join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────

/** The generated references, read from the repository. */
export function referenceDocs(): ReferenceDoc[] {
  const bootstrap = readRepoFile(AGENT_BOOTSTRAP);
  const spec = readRepoFile(GATEWAY_SPEC);
  return [
    {
      file: 'reference/refusals.mdx',
      path: '/docs/reference/refusals',
      title: 'Refusals',
      description: `Every code the gateway refuses a call with (${REFUSAL_CODES.length}), what happened, what the agent does and what the person does next.`,
      body: refusalsMarkdown(bootstrap),
      sources: [ERRORS_SOURCE, 'packages/shared/src/refusal.ts', AGENT_BOOTSTRAP],
    },
    {
      file: 'reference/trust-levels.mdx',
      path: '/docs/reference/trust-levels',
      title: 'Rows by trust level',
      description:
        'What Careful, Trusting and Autonomous do with each row of permissions, the limits they give, and how a permission gets its row.',
      body: trustLevelsMarkdown(),
      sources: [
        'packages/policy-engine/src/trust-level.ts',
        'packages/policy-engine/src/risk-words.ts',
      ],
    },
    {
      file: 'reference/words.mdx',
      path: '/docs/reference/words',
      title: 'Words',
      description:
        "The interface's words and the protocol's: what an agent, a log or the API calls each thing a person sees.",
      body: wordsMarkdown(spec),
      sources: [GATEWAY_SPEC],
    },
    {
      file: 'reference/for-agents.mdx',
      path: '/docs/reference/for-agents',
      title: 'For agents',
      description:
        'The reference every instance serves to agents at /agent-bootstrap.md: endpoint, discovery, limits, refusals, proposing a mission, git.',
      body: forAgentsMarkdown(bootstrap),
      sources: [AGENT_BOOTSTRAP],
    },
  ];
}
