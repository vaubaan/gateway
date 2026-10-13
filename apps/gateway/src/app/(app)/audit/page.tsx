/**
 * `/audit` — search the audit by mission, user, connection, tool, decision,
 * token holder, agent label and period (spec §4.2, §7.9, §8). A user sees the
 * entries about their missions and their connections; an operator sees the
 * administrative entries too. Arguments are never shown: an entry only holds
 * their hash.
 *
 * Two columns say who called. "Token holder" is authenticated: the member, or
 * the named token, whose token the call presented. "Agent label" is what the
 * caller declared about itself.
 */
import Link from 'next/link';

import { isOperatorPrincipal } from '@/components/auth/principal';
import { LocalDate } from '@/components/LocalDate';
import {
  Badge,
  Button,
  Card,
  Input,
  Select,
  Table,
  Tbody,
  Td,
  Th,
  Thead,
  Tr,
  Slug,
} from '@/components/ui';
import { RiskIdLink } from '@/components/risk/RiskExplain';
import { requirePrincipal } from '@/lib/auth/session';
import {
  AUDIT_DECISIONS,
  AUDIT_KINDS,
  AUDIT_PARAMS,
  auditQueryString,
  parseAuditQuery,
  type AuditAdminView,
  type AuditCallView,
  type AuditEntryView,
} from '@/server/audit';

import styles from './audit.module.css';

export const dynamic = 'force-dynamic';

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function AuditPage({ searchParams }: Props) {
  const { root, principal } = await requirePrincipal();
  const query = parseAuditQuery(await searchParams);
  const { raw } = query;
  const [page, options] = await Promise.all([
    root.audit.query.search(principal, query.filters, query.cursor),
    root.audit.query.filterOptions(principal),
  ]);
  const seesAdmin = isOperatorPrincipal(principal);

  return (
    <>
      <div className={styles.pageHead}>
        <div>
          <h1>Audit</h1>
          <p className={styles.muted}>
            One entry per call, allowed or refused, and per administrative act
            {seesAdmin
              ? ' — your missions, your connections and every administrative act.'
              : ' — on your missions and your connections.'}{' '}
            Kept {root.config.retentionDays} days. Arguments are never stored: only their hash.
          </p>
        </div>
      </div>

      {query.problems.length > 0 && (
        <ul className={styles.problems}>
          {query.problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}

      <form method="get" action="/audit" className={`${styles.filters} ${styles.wide}`}>
        <label className={styles.filter}>
          <span>Mission</span>
          <Select name={AUDIT_PARAMS.mission} defaultValue={raw.mission ?? ''}>
            <option value="">all</option>
            {withCurrent(options.missions, raw.mission).map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </Select>
        </label>
        <label className={styles.filter}>
          <span>User</span>
          <Input
            name={AUDIT_PARAMS.user}
            defaultValue={raw.user ?? ''}
            placeholder="email"
            autoComplete="off"
          />
        </label>
        <label className={styles.filter}>
          <span>Connection</span>
          <Select name={AUDIT_PARAMS.connection} defaultValue={raw.connection ?? ''}>
            <option value="">all</option>
            {withCurrent(
              options.connections.map((c) => ({ id: c.id, name: c.label })),
              raw.connection,
            ).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </label>
        <label className={styles.filter}>
          <span>Tool</span>
          <Input
            name={AUDIT_PARAMS.tool}
            defaultValue={raw.tool ?? ''}
            placeholder="exact name"
            autoComplete="off"
          />
        </label>
        <label className={styles.filter}>
          <span>Decision</span>
          <Select name={AUDIT_PARAMS.decision} defaultValue={raw.decision ?? ''}>
            <option value="">any</option>
            {AUDIT_DECISIONS.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </Select>
        </label>
        <label className={styles.filter}>
          <span title="Whose token the call presented: a member of the mission (their email) or a named token (its name). Authenticated by the token.">
            Token holder
          </span>
          <Input
            name={AUDIT_PARAMS.holder}
            defaultValue={raw.holder ?? ''}
            placeholder="email or name"
            autoComplete="off"
          />
        </label>
        <label className={styles.filter}>
          <span title="What the caller declared about itself; not verified, not an identity">
            Agent label
          </span>
          <Input
            name={AUDIT_PARAMS.agent}
            defaultValue={raw.agent ?? ''}
            placeholder="exact label"
            autoComplete="off"
          />
        </label>
        <label className={styles.filter}>
          <span>Kind</span>
          <Select name={AUDIT_PARAMS.kind} defaultValue={raw.kind ?? ''}>
            <option value="">any</option>
            {AUDIT_KINDS.map((k) => (
              <option key={k} value={k}>
                {k === 'call' ? 'calls' : 'administrative acts'}
              </option>
            ))}
          </Select>
        </label>
        <label className={styles.filter}>
          <span>From (UTC)</span>
          <Input type="date" name={AUDIT_PARAMS.from} defaultValue={raw.from ?? ''} />
        </label>
        <label className={styles.filter}>
          <span>To (UTC)</span>
          <Input type="date" name={AUDIT_PARAMS.to} defaultValue={raw.to ?? ''} />
        </label>
        <div className={styles.filterActions}>
          <Button type="submit" variant="primary">
            Search
          </Button>
          <Link href="/audit">Clear</Link>
        </div>
      </form>

      <Card className={styles.wide}>
        {page.entries.length === 0 ? (
          <div className={styles.empty}>No entry matches.</div>
        ) : (
          <div className={styles.scroll} data-testid="audit-table">
            <Table>
              <Thead>
                <Tr>
                  <Th>When</Th>
                  <Th>Decision</Th>
                  <Th>Mission, agent label / actor</Th>
                  <Th>Token holder</Th>
                  <Th>Call / act</Th>
                  <Th>Risks touched → left</Th>
                  <Th>Arguments (hash), detail</Th>
                </Tr>
              </Thead>
              <Tbody>
                {page.entries.map((entry) => (
                  <EntryRow key={entry.id} entry={entry} />
                ))}
              </Tbody>
            </Table>
          </div>
        )}
      </Card>

      <div className={styles.pager}>
        <span>
          {page.entries.length} {page.entries.length === 1 ? 'entry' : 'entries'}, newest first
        </span>
        <span>
          {query.cursor && <Link href={`/audit?${auditQueryString(raw, null)}`}>Newest</Link>}
          {query.cursor && page.next && ' · '}
          {page.next && <Link href={`/audit?${auditQueryString(raw, page.next)}`}>Older</Link>}
        </span>
      </div>
    </>
  );
}

/** A filter value that is not among the viewer's own (a shared link) stays selectable. */
function withCurrent(
  options: readonly { id: string; name: string }[],
  current: string | undefined,
): readonly { id: string; name: string }[] {
  if (!current || options.some((o) => o.id === current)) return options;
  return [...options, { id: current, name: current }];
}

function EntryRow({ entry }: { entry: AuditEntryView }) {
  return entry.kind === 'call' ? <CallRow entry={entry} /> : <AdminRow entry={entry} />;
}

function CallRow({ entry }: { entry: AuditCallView }) {
  const connection = entry.connection
    ? (entry.connection.display_name ?? entry.connection.id)
    : null;
  return (
    <Tr>
      <Td>
        <LocalDate ts={entry.ts} />
      </Td>
      <Td className={styles.nowrap}>
        <Badge tone={entry.decision === 'allowed' ? 'success' : 'danger'}>{entry.decision}</Badge>
        {entry.refusal_code && <div className={styles.mono}>{entry.refusal_code}</div>}
      </Td>
      <Td>
        {entry.mission.name ? (
          <Slug kind="mission" mono={false}>
            {entry.mission.name}
          </Slug>
        ) : (
          'deleted mission'
        )}
        {entry.mission.creator_email && (
          <div className={styles.muted}>{entry.mission.creator_email}</div>
        )}
        {entry.agent_label && <div className={styles.muted}>agent {entry.agent_label}</div>}
      </Td>
      <Td className={styles.holder} data-testid="audit-holder">
        {entry.token ? (
          <>
            {entry.token.label}
            {entry.token.kind === 'named' && (
              <div>
                <Badge>named token</Badge>
              </div>
            )}
          </>
        ) : (
          <span className={styles.muted} title="Written before tokens had a holder">
            not attributed
          </span>
        )}
      </Td>
      <Td>
        <Slug kind="tool">{entry.tool}</Slug>
        {(connection || entry.resource_ref) && (
          <div className={styles.where}>
            {connection && (
              <Slug kind="connection" mono={false}>
                {connection}
              </Slug>
            )}
            {entry.resource_ref && <Slug kind="resource">{entry.resource_ref}</Slug>}
          </div>
        )}
      </Td>
      <Td>
        {entry.risks_touched.length === 0 ? (
          '—'
        ) : (
          <div className={styles.risks}>
            {entry.risks_touched.map((risk) => (
              <span key={risk} className={`${styles.mono} ${styles.wraps}`}>
                <RiskIdLink riskId={risk} />
                {entry.remaining_budget?.[risk] !== undefined &&
                  ` → ${entry.remaining_budget[risk]}`}
              </span>
            ))}
          </div>
        )}
      </Td>
      <Td>
        <div className={`${styles.mono} ${styles.hash}`} data-testid="arguments-hash">
          {entry.arguments_hash}
        </div>
        {entry.upstream_error && <div>upstream failed: {entry.upstream_error}</div>}
        {entry.upstream_latency_ms !== null && (
          <div className={`${styles.muted} ${styles.nowrap}`}>
            {entry.upstream_latency_ms} ms upstream
          </div>
        )}
        {entry.approval_id && <div className={styles.muted}>approval consumed</div>}
        {entry.refusal_reason && (
          <details className={styles.fold}>
            <summary>what the agent was told</summary>
            <p className={styles.reason}>{entry.refusal_reason}</p>
          </details>
        )}
        {entry.client_ip && (
          <div className={`${styles.muted} ${styles.nowrap}`}>from {entry.client_ip}</div>
        )}
      </Td>
    </Tr>
  );
}

function AdminRow({ entry }: { entry: AuditAdminView }) {
  const hasState = entry.before !== null || entry.after !== null;
  return (
    <Tr>
      <Td>
        <LocalDate ts={entry.ts} />
      </Td>
      <Td>
        <Badge>act</Badge>
      </Td>
      <Td>
        {entry.actor.label}
        {entry.delegated_client_id && (
          <div className={styles.muted}>through client {entry.delegated_client_id}</div>
        )}
      </Td>
      <Td>—</Td>
      <Td>
        <span className={`${styles.mono} ${styles.nowrap}`}>{entry.act}</span>
        <div className={styles.muted}>
          {entry.object.type}
          {entry.object.label ? ` · ${entry.object.label}` : ` · ${entry.object.id}`}
        </div>
      </Td>
      <Td>—</Td>
      <Td>
        {hasState && (
          <details className={styles.fold}>
            <summary>before / after</summary>
            <pre className={styles.state}>
              {JSON.stringify({ before: entry.before, after: entry.after }, null, 2)}
            </pre>
          </details>
        )}
      </Td>
    </Tr>
  );
}
