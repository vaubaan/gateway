/**
 * `/activity` — the audit record (spec §4.2 "Audit", §7.9, §8): one line per
 * call, allowed or refused, and per change a person made, newest first, with
 * filters by period, mission, account, tool, decision, person, key holder,
 * agent and kind.
 *
 * Who reads what is the service's (`AuditQueryService`): a person reads the
 * missions they created, the ones shared with them and the accounts they own;
 * an administrator reads everything. Arguments are never stored; the detail
 * of a row shows their fingerprint to whoever answers for the call, and says
 * so to anyone else.
 *
 * Six columns by default (the documented exception: a log is rows); the
 * mission is a seventh behind "Show details", and everything else about a
 * line — the key, the permissions touched and what is left, the fingerprint,
 * what the agent was told — is in its detail, opened by `?open=<id>` so that
 * a line can be linked.
 */
import Link from 'next/link';

import { isOperatorPrincipal } from '@/components/auth/principal';
import {
  AgentLabel,
  Avatar,
  Button,
  Callout,
  CodeBlock,
  DataTable,
  DetailScope,
  DetailToggle,
  Disclosure,
  Field,
  GateMark,
  Hint,
  Input,
  KeyValue,
  Mono,
  PageHeader,
  Segmented,
  Select,
  SummaryLine,
  type Column,
  type RowTone,
} from '@/components/ui';
import { requirePrincipal } from '@/lib/auth/session';
import {
  ACCOUNT_WORDS,
  ACT_WORDS,
  ACTIVITY_PERIODS,
  ACTIVITY_SCOPE,
  ACTIVITY_WORDS,
  activityLede,
  count,
  DECISION_WORDS,
  formatNumber,
  PAGES,
  REFUSAL_WORDS,
  ROUTES,
  TERMS,
} from '@/lib/vocabulary';
import {
  AUDIT_DECISIONS,
  AUDIT_KINDS,
  AUDIT_PARAMS,
  auditQueryString,
  parseAuditQuery,
  type AuditAdminView,
  type AuditCallView,
  type AuditEntryView,
  type ParsedAuditQuery,
} from '@/server/audit';
import type { CatalogRisk } from '@/server/missions/model';
import { riskReferencePath } from '@/server/providers/links';
import { riskExplainer } from '@/server/providers/reference';

import styles from './activity.module.css';
import { changeLines, type ChangeNames } from './change-lines';
import { When } from './when';

export const dynamic = 'force-dynamic';

/** The query parameter that opens the detail of one line. */
const OPEN_PARAM = 'open';
const MS_PER_DAY = 86_400_000;

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

type Raw = ParsedAuditQuery['raw'];
type Explain = (riskId: string) => CatalogRisk | null;

function first(value: string | string[] | undefined): string | null {
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}

/** `/activity` with these filters, at this position, with this line open. */
function hrefOf(raw: Raw, cursor: string | undefined, open: string | null): string {
  const params = new URLSearchParams(auditQueryString(raw, null));
  if (cursor) params.set(AUDIT_PARAMS.cursor, cursor);
  if (open) params.set(OPEN_PARAM, open);
  const query = params.toString();
  return `${ROUTES.activity}${query ? `?${query}` : ''}${open ? `#${rowAnchor(open)}` : ''}`;
}

function rowAnchor(id: string): string {
  return `entry-${id}`;
}

/** A day of the record, as the filters spell it (UTC). */
function day(date: Date): string {
  return date.toISOString().slice(0, 10);
}

type Period = keyof typeof ACTIVITY_PERIODS;
/** A period typed by hand in "More filters": no segment is the current one. */
const CUSTOM_PERIOD = 'custom' as Period;

/** The four periods as filter values, and which one the query is on (`null`: a custom one). */
function periods(raw: Raw, now: Date) {
  const today = day(now);
  const yesterday = day(new Date(now.getTime() - MS_PER_DAY));
  const weekAgo = day(new Date(now.getTime() - 6 * MS_PER_DAY));
  const ranges: Readonly<Record<Period, { from?: string; to?: string }>> = {
    today: { from: today },
    yesterday: { from: yesterday, to: yesterday },
    week: { from: weekAgo },
    all: {},
  };
  const current =
    (Object.keys(ranges) as Period[]).find(
      (key) => ranges[key].from === raw.from && ranges[key].to === raw.to,
    ) ?? null;
  return { ranges, current };
}

/** A filter value that is not among the viewer's own (a shared link) stays selectable. */
function withCurrent(
  options: readonly { id: string; name: string }[],
  current: string | undefined,
): readonly { id: string; name: string }[] {
  if (!current || options.some((o) => o.id === current)) return options;
  return [...options, { id: current, name: current }];
}

function isAsk(entry: AuditEntryView): boolean {
  return entry.kind === 'call' && entry.refusal_code === 'approval-required';
}

function toneOf(entry: AuditEntryView): RowTone | undefined {
  if (entry.kind !== 'call' || entry.decision === 'allowed') return undefined;
  return isAsk(entry) ? 'warn' : 'bad';
}

function Who({ entry }: { entry: AuditEntryView }) {
  if (entry.kind === 'admin') {
    return (
      <span className={styles.who}>
        <Avatar name={entry.actor.label} size="xs" />
        <span className={styles.whoText}>
          <span>{entry.actor.label}</span>
          {entry.delegated_client_id && (
            <span className={styles.sub}>
              through an app <Mono quiet>{entry.delegated_client_id}</Mono>
            </span>
          )}
        </span>
      </span>
    );
  }
  if (!entry.token) {
    return (
      <span className={styles.quiet} title="Recorded before a call said whose key it used">
        {ACTIVITY_WORDS.notAttributed}
      </span>
    );
  }
  const machine = entry.token.kind === 'named';
  return (
    <span className={styles.who} data-testid="audit-holder">
      <Avatar name={entry.token.label} kind={machine ? 'machine' : 'person'} size="xs" />
      <span className={styles.whoText}>
        <span>
          {entry.token.label}
          {machine && <span className={styles.quiet}> · {ACTIVITY_WORDS.machineKey}</span>}
        </span>
        {entry.agent_label && <AgentLabel>{entry.agent_label}</AgentLabel>}
      </span>
    </span>
  );
}

function Action({ entry }: { entry: AuditEntryView }) {
  if (entry.kind === 'call') return <Mono>{entry.tool}</Mono>;
  return <span>{ACT_WORDS[entry.act]}</span>;
}

function On({ entry }: { entry: AuditEntryView }) {
  if (entry.kind === 'admin') {
    return (
      <span className={styles.onText}>
        {entry.object.label ?? <Mono quiet>{entry.object.id}</Mono>}
      </span>
    );
  }
  const account = entry.connection ? (entry.connection.display_name ?? entry.connection.id) : null;
  if (!account && !entry.resource_ref) return <span className={styles.quiet}>—</span>;
  return (
    <span className={styles.onText}>
      {entry.resource_ref && <Mono>{entry.resource_ref}</Mono>}
      {account && <span className={styles.sub}>{account}</span>}
    </span>
  );
}

function Permission({ entry, explain }: { entry: AuditEntryView; explain: Explain }) {
  if (entry.kind !== 'call' || entry.risks_touched.length === 0) {
    return <span className={styles.quiet}>—</span>;
  }
  const [firstId, ...others] = entry.risks_touched;
  const label = firstId ? (explain(firstId)?.label ?? firstId) : '';
  return (
    <span className={styles.permission} title={entry.risks_touched.join(', ')}>
      {label}
      {others.length > 0 && <span className={styles.quiet}> +{formatNumber(others.length)}</span>}
    </span>
  );
}

function Decision({
  entry,
  you,
  detailHref,
  open,
}: {
  entry: AuditEntryView;
  /** The email of the reader, to say "asked you" of their own missions. */
  you: string | null;
  detailHref: string;
  open: boolean;
}) {
  const link = (
    <Link
      href={detailHref}
      scroll={false}
      className={styles.detailLink}
      aria-expanded={open}
      aria-label={`${open ? 'Hide' : 'Show'} the detail of this line`}
      data-testid="entry-detail-link"
    >
      {open ? ACTIVITY_WORDS.hideDetail : ACTIVITY_WORDS.detail}
    </Link>
  );
  if (entry.kind === 'admin') {
    return (
      <span className={styles.decision}>
        <span className={styles.quiet}>{DECISION_WORDS.act.label}</span>
        {link}
      </span>
    );
  }
  if (entry.decision === 'allowed') {
    return (
      <span className={styles.decision} data-decision="allowed">
        <span className={styles.quiet}>
          {DECISION_WORDS.allowed.label}
          {entry.approval_id && ` · ${ACTIVITY_WORDS.afterYes}`}
        </span>
        {link}
      </span>
    );
  }
  if (isAsk(entry)) {
    const creator = entry.mission.creator_email;
    return (
      <span className={styles.decision} data-decision="asked">
        <GateMark gate="ask">
          {creator && creator === you ? DECISION_WORDS.asked.label : `asked ${creator ?? 'first'}`}
        </GateMark>
        {link}
      </span>
    );
  }
  return (
    <span className={styles.decision} data-decision="refused">
      <span className={styles.refused}>{DECISION_WORDS.refused.label}</span>
      {entry.refusal_code && (
        <span className={styles.quiet}>· {REFUSAL_WORDS[entry.refusal_code]}</span>
      )}
      {link}
    </span>
  );
}

function CallDetail({ entry, explain }: { entry: AuditCallView; explain: Explain }) {
  const account = entry.connection ? (entry.connection.display_name ?? entry.connection.id) : null;
  return (
    <KeyValue
      items={[
        {
          term: ACTIVITY_WORDS.mission,
          value: entry.mission.name ? (
            <>
              <Link
                href={`${ROUTES.missions}/${encodeURIComponent(entry.mission.id)}`}
                className={styles.detailLink}
              >
                {entry.mission.name}
              </Link>
              {entry.mission.creator_email && ` · created by ${entry.mission.creator_email}`}
            </>
          ) : (
            'a mission that no longer exists'
          ),
        },
        {
          term: 'Key',
          value: entry.token
            ? `${entry.token.label}${entry.token.kind === 'named' ? ` · ${ACTIVITY_WORDS.machineKey}` : ''}${
                entry.agent_label ? ` · agent label “${entry.agent_label}”` : ''
              }`
            : ACTIVITY_WORDS.notAttributed,
        },
        {
          term: 'Tool',
          value: (
            <>
              <Mono>{entry.tool}</Mono>
              {account && ` · ${account}`}
              {entry.resource_ref && (
                <>
                  {' · '}
                  <Mono>{entry.resource_ref}</Mono>
                </>
              )}
            </>
          ),
        },
        {
          term: 'Permissions touched',
          value:
            entry.risks_touched.length === 0 ? (
              'none'
            ) : (
              <span className={styles.touched}>
                {entry.risks_touched.map((riskId) => (
                  <span key={riskId}>
                    {explain(riskId)?.label ?? riskId}{' '}
                    <Mono quiet href={riskReferencePath(riskId) ?? undefined}>
                      {riskId}
                    </Mono>
                    {entry.remaining_budget?.[riskId] !== undefined &&
                      ` → ${formatNumber(entry.remaining_budget[riskId])} left`}
                  </span>
                ))}
              </span>
            ),
        },
        {
          term: 'Arguments',
          value:
            entry.arguments_hash === null ? (
              <span data-testid="arguments-hash-hidden">{ACTIVITY_WORDS.fingerprintHidden}</span>
            ) : (
              <>
                {ACTIVITY_WORDS.argumentsNeverStored} · fingerprint{' '}
                <span data-testid="arguments-hash">
                  <Mono>{entry.arguments_hash}</Mono>
                </span>
              </>
            ),
        },
        ...(entry.refusal_code
          ? [
              {
                term: 'Refused',
                value: (
                  <>
                    <Mono>{entry.refusal_code}</Mono>
                    {entry.refusal_reason && (
                      <span className={styles.told}>
                        What the agent was told: {entry.refusal_reason}
                      </span>
                    )}
                  </>
                ),
              },
            ]
          : []),
        ...(entry.approval_id ||
        entry.upstream_latency_ms !== null ||
        entry.upstream_error ||
        entry.client_ip
          ? [
              {
                term: 'Technical detail',
                value: [
                  entry.approval_id ? 'used a yes you gave' : null,
                  entry.upstream_latency_ms !== null
                    ? `${formatNumber(entry.upstream_latency_ms)} ms at the service`
                    : null,
                  entry.upstream_error ? `the service failed: ${entry.upstream_error}` : null,
                  entry.client_ip ? `from ${entry.client_ip}` : null,
                ]
                  .filter(Boolean)
                  .join(' · '),
              },
            ]
          : []),
      ]}
    />
  );
}

function AdminDetail({ entry, names }: { entry: AuditAdminView; names: ChangeNames }) {
  const hasState = entry.before !== null || entry.after !== null;
  const lines = changeLines(entry.before, entry.after, names, entry.object.type);
  return (
    <>
      <KeyValue
        items={[
          { term: 'Change', value: <Mono>{entry.act}</Mono> },
          {
            term: 'On',
            value: (
              <>
                {entry.object.type}
                {entry.object.label ? ` · ${entry.object.label}` : ''} ·{' '}
                <Mono quiet>{entry.object.id}</Mono>
              </>
            ),
          },
          {
            term: 'By',
            value: entry.delegated_client_id ? (
              <>
                {entry.actor.label}, through the app <Mono>{entry.delegated_client_id}</Mono>
              </>
            ) : (
              entry.actor.label
            ),
          },
          // What changed, in words: the account by its name, each permission with its limits.
          ...lines.map((line) => ({
            term: line.label,
            value: (
              <span data-testid="change-line">
                {line.value}
                {line.was !== undefined && <span className={styles.quiet}> · was {line.was}</span>}
                {line.id && (
                  <>
                    {' '}
                    <Mono quiet>{line.id}</Mono>
                  </>
                )}
              </span>
            ),
          })),
        ]}
      />
      {hasState && (
        <div className={styles.state}>
          {/* The record as it is stored, in the protocol's names: one click away. */}
          <Disclosure
            id="activity:raw-record"
            show="Show the raw record"
            hide="Hide the raw record"
            testId="change-raw"
          >
            <CodeBlock label="Before and after" copy={false}>
              {JSON.stringify({ before: entry.before, after: entry.after }, null, 2)}
            </CodeBlock>
          </Disclosure>
        </div>
      )}
    </>
  );
}

export default async function ActivityPage({ searchParams }: Props) {
  const { root, principal } = await requirePrincipal();
  const params = await searchParams;
  const query = parseAuditQuery(params);
  const { raw } = query;
  const opened = first(params[OPEN_PARAM]);
  const [page, options] = await Promise.all([
    root.audit.query.search(principal, query.filters, query.cursor),
    root.audit.query.filterOptions(principal),
  ]);
  const explain = riskExplainer(root.registry);
  // The one change a person opened is printed in words: the names behind its ids.
  const openedChange = page.entries.find(
    (entry): entry is AuditAdminView => entry.kind === 'admin' && entry.id === opened,
  );
  const changeNames: ChangeNames = {
    ids: openedChange ? await root.audit.query.changeNames(openedChange) : {},
    permission: (riskId) => explain(riskId)?.label ?? null,
  };
  const now = new Date();
  const { ranges, current } = periods(raw, now);
  const you = principal.kind === 'user' ? principal.user.email : null;
  const scope = isOperatorPrincipal(principal)
    ? principal.kind === 'user'
      ? ACTIVITY_SCOPE.administrator
      : ACTIVITY_SCOPE.installer
    : ACTIVITY_SCOPE.person;
  const filtered = Object.keys(raw).some((key) => key !== 'cursor');
  const moreSet = Boolean(raw.user ?? raw.holder ?? raw.agent ?? raw.kind) || current === null;

  const calls = page.entries.filter((entry): entry is AuditCallView => entry.kind === 'call');
  const refused = calls.filter((entry) => entry.decision === 'refused' && !isAsk(entry)).length;
  const asked = calls.filter(isAsk).length;
  const changes = page.entries.length - calls.length;

  const columns: readonly Column<AuditEntryView>[] = [
    {
      id: 'time',
      header: ACTIVITY_WORDS.time,
      nowrap: true,
      width: '92px',
      cell: (entry) => (
        <span id={rowAnchor(entry.id)} className={styles.time}>
          <When ts={entry.ts} />
        </span>
      ),
    },
    {
      id: 'who',
      header: ACTIVITY_WORDS.who,
      width: '21%',
      cell: (entry) => <Who entry={entry} />,
    },
    {
      id: 'action',
      header: ACTIVITY_WORDS.action,
      width: '22%',
      cell: (entry) => <Action entry={entry} />,
    },
    { id: 'on', header: ACTIVITY_WORDS.on, cell: (entry) => <On entry={entry} /> },
    {
      id: 'permission',
      header: ACTIVITY_WORDS.permission,
      cell: (entry) => <Permission entry={entry} explain={explain} />,
    },
    {
      id: 'mission',
      header: ACTIVITY_WORDS.mission,
      detail: true,
      cell: (entry) =>
        entry.kind === 'call' ? (
          (entry.mission.name ?? <span className={styles.quiet}>gone</span>)
        ) : (
          <span className={styles.quiet}>—</span>
        ),
    },
    {
      id: 'decision',
      header: ACTIVITY_WORDS.decision,
      width: '17%',
      cell: (entry) => {
        const open = opened === entry.id;
        return (
          <Decision
            entry={entry}
            you={you}
            open={open}
            detailHref={hrefOf(raw, raw.cursor, open ? null : entry.id)}
          />
        );
      },
    },
  ];

  return (
    <DetailScope id="activity:columns">
      <PageHeader
        title={PAGES.activity.title}
        lede={activityLede(root.config.retentionDays)}
        width="wide"
        secondary={[<DetailToggle key="details" />]}
      />

      {query.problems.length > 0 && (
        <div className={styles.problems}>
          <Callout tone="warn" title="Some filters were not understood and were left out">
            {query.problems.map((problem) => (
              <p key={problem}>{problem}</p>
            ))}
          </Callout>
        </div>
      )}

      <form method="get" action={ROUTES.activity} className={styles.filters}>
        <div className={styles.filterRow}>
          <Segmented
            label="Period"
            value={current ?? CUSTOM_PERIOD}
            options={(Object.keys(ACTIVITY_PERIODS) as Period[]).map((key) => ({
              value: key,
              label: ACTIVITY_PERIODS[key],
              href: hrefOf({ ...raw, from: ranges[key].from, to: ranges[key].to }, undefined, null),
            }))}
          />
          <Select
            size="sm"
            name={AUDIT_PARAMS.mission}
            defaultValue={raw.mission ?? ''}
            aria-label={ACTIVITY_WORDS.mission}
            className={styles.select}
          >
            <option value="">All missions</option>
            {withCurrent(options.missions, raw.mission).map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </Select>
          <Select
            size="sm"
            name={AUDIT_PARAMS.connection}
            defaultValue={raw.connection ?? ''}
            aria-label={ACCOUNT_WORDS.account}
            className={styles.select}
          >
            <option value="">All accounts</option>
            {withCurrent(
              options.connections.map((c) => ({ id: c.id, name: c.label })),
              raw.connection,
            ).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
          <Select
            size="sm"
            name={AUDIT_PARAMS.decision}
            defaultValue={raw.decision ?? ''}
            aria-label={ACTIVITY_WORDS.decision}
            className={styles.select}
          >
            <option value="">Allowed and refused</option>
            {AUDIT_DECISIONS.map((d) => (
              <option key={d} value={d}>
                {DECISION_WORDS[d].label}
              </option>
            ))}
          </Select>
          <Input
            size="sm"
            name={AUDIT_PARAMS.tool}
            defaultValue={raw.tool ?? ''}
            placeholder="Tool, exact name"
            aria-label="Tool, exact name"
            autoComplete="off"
            className={styles.tool}
            mono
          />
          <Button type="submit" size="sm">
            {ACTIVITY_WORDS.apply}
          </Button>
          {filtered && (
            <Link href={ROUTES.activity} className={styles.clear}>
              {ACTIVITY_WORDS.clear}
            </Link>
          )}
        </div>
        <Disclosure
          id="activity:more-filters"
          show={ACTIVITY_WORDS.moreFilters}
          hide={ACTIVITY_WORDS.fewerFilters}
          defaultOpen={moreSet}
          testId="more-filters"
        >
          <div className={styles.moreFilters}>
            <Field label="Person" shape="who made a change, by email" htmlFor="activity-user">
              <Input
                id="activity-user"
                size="sm"
                name={AUDIT_PARAMS.user}
                defaultValue={raw.user ?? ''}
                autoComplete="off"
              />
            </Field>
            <Field
              label="Who"
              shape="an email, or the name of a machine key"
              htmlFor="activity-holder"
            >
              <Input
                id="activity-holder"
                size="sm"
                name={AUDIT_PARAMS.holder}
                defaultValue={raw.holder ?? ''}
                autoComplete="off"
              />
            </Field>
            <Field label="Agent" shape="the label it gave itself, exact" htmlFor="activity-agent">
              <Input
                id="activity-agent"
                size="sm"
                name={AUDIT_PARAMS.agent}
                defaultValue={raw.agent ?? ''}
                autoComplete="off"
              />
            </Field>
            <Field label="Kind" htmlFor="activity-kind">
              <Select
                id="activity-kind"
                size="sm"
                name={AUDIT_PARAMS.kind}
                defaultValue={raw.kind ?? ''}
              >
                <option value="">Calls and changes</option>
                {AUDIT_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {k === 'call' ? 'Calls only' : 'Changes only'}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="From" shape="a day, UTC" htmlFor="activity-from">
              <Input
                id="activity-from"
                size="sm"
                type="date"
                name={AUDIT_PARAMS.from}
                defaultValue={raw.from ?? ''}
              />
            </Field>
            <Field label="To" shape="a day, UTC" htmlFor="activity-to">
              <Input
                id="activity-to"
                size="sm"
                type="date"
                name={AUDIT_PARAMS.to}
                defaultValue={raw.to ?? ''}
              />
            </Field>
          </div>
        </Disclosure>
      </form>

      <div className={styles.counts}>
        <SummaryLine
          items={[
            { label: `${count(calls.length, TERMS.call)}` },
            ...(refused > 0 ? [{ label: `${formatNumber(refused)} refused` }] : []),
            ...(asked > 0 ? [{ label: `${formatNumber(asked)} asked first` }] : []),
            ...(changes > 0
              ? [{ label: `${formatNumber(changes)} ${changes === 1 ? 'change' : 'changes'}` }]
              : []),
            { label: <span className={styles.quiet}>{scope}</span> },
          ]}
        />
      </div>

      <div data-testid="audit-table">
        <DataTable
          caption="The record, newest first"
          columns={columns}
          rows={page.entries}
          rowKey={(entry) => entry.id}
          columnBudget={6}
          density="tight"
          rowTone={toneOf}
          rowDetail={(entry) =>
            opened === entry.id ? (
              <div data-testid="entry-detail">
                {entry.kind === 'call' ? (
                  <CallDetail entry={entry} explain={explain} />
                ) : (
                  <AdminDetail entry={entry} names={changeNames} />
                )}
              </div>
            ) : null
          }
          empty={<Hint>{ACTIVITY_WORDS.nothing}</Hint>}
        />
      </div>

      <Hint>
        {formatNumber(page.entries.length)} {page.entries.length === 1 ? 'line' : 'lines'}, newest
        first
        {query.cursor && (
          <>
            {' · '}
            <Link href={hrefOf(raw, undefined, null)}>{ACTIVITY_WORDS.newest}</Link>
          </>
        )}
        {page.next && (
          <>
            {' · '}
            <Link href={`${ROUTES.activity}?${auditQueryString(raw, page.next)}`}>
              {ACTIVITY_WORDS.earlier}
            </Link>
          </>
        )}
        {' · '}Arguments are never stored; a line’s detail shows their fingerprint and the
        permissions touched.
      </Hint>
    </DetailScope>
  );
}
