/**
 * `/missions/<id>` — one mission: state, connections and resources, policy
 * per risk — each explained (label, reason, vector) and linked to its entry
 * in the provider reference — with what is left this period and its gate,
 * which the creator edits here after issuance (spec §3.5), token prefix with
 * Rotate, the
 * bootstrap kit with the secret masked (spec §4.2, §4.4), and the link to the
 * mission's session page, and the mission's members and tokens (`TeamSection`).
 *
 * The creator and the members of a mission read this page (spec §0 "Mission
 * member"). A member reads it as it is: no Duplicate / Rotate / Revoke, no gate
 * control — what they can do is in "Members and tokens": their own token.
 */
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { LocalDate } from '@/components/LocalDate';
import { NeedsUser } from '@/components/auth/NeedsUser';
import {
  Badge,
  Banner,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Code,
  Stack,
  Table,
  Tbody,
  Td,
  Th,
  Thead,
  Tr,
  Slug,
} from '@/components/ui';
import { GateBadge } from '@/components/risk/RiskBadges';
import { RiskExplain, RiskIdLink } from '@/components/risk/RiskExplain';
import { currentUser } from '@/lib/auth/session';
import { maskedToken } from '@/server/missions';
import { explainOrphan } from '@/server/missions/orphan-reason';
import { formatRate } from '@/server/missions/catalog-view';
import { reloadPhrase } from '@/server/missions/summary';
import { providerPath } from '@/server/providers/links';
import { riskExplainer } from '@/server/providers/reference';

import { BootstrapKitView } from '../bootstrap-kit-view';
import styles from '../missions.module.css';
import { StateBadge } from '../state-badge';
import { GateControl } from './gate-control';
import { MissionActions } from './mission-actions';
import { TeamSection } from './team-section';

export const dynamic = 'force-dynamic';

interface Props {
  params: Promise<{ id: string }>;
}

export default async function MissionPage({ params }: Props) {
  const session = await currentUser();
  if (!session) return <NeedsUser />;
  const { id } = await params;
  const detail = await session.root.missions.service.get(session.user, id);
  if (!detail) notFound();
  const { mission, state, token, orphan, issuedVia } = detail;
  const isCreator = detail.role === 'creator';
  const team = await session.root.missions.team.team(session.user, id);
  // The service's own rule (`gateEditBlockedBy`): the control shows when `setGate` would act.
  const gatesEditable = detail.gates_editable;
  const orphanExplanation = orphan && explainOrphan(orphan, detail.connections);
  // The catalog row behind each persisted id: what the risk means, not only what it is called.
  const explain = riskExplainer(session.root.registry);

  return (
    <Stack gap="var(--space-5)">
      <div className={styles.pageHead}>
        <div>
          <p className={styles.muted}>
            <Link href="/missions">Missions</Link> /
          </p>
          <h1>
            {mission.name} <StateBadge state={state} />
          </h1>
        </div>
        <div className={styles.actions}>
          <Link href={`/missions/${mission.id}/session`} className={styles.secondaryLink}>
            Session
          </Link>
          {isCreator && (
            <MissionActions
              missionId={mission.id}
              name={mission.name}
              active={state.kind === 'active'}
              revocable={state.kind !== 'revoked'}
            />
          )}
        </div>
      </div>

      {!isCreator && (
        <div data-testid="shared-with-me">
          <Banner tone="info" title="Shared with you">
            <p>
              {detail.creator.email ?? 'Its creator'} created this mission and added you as a
              member. You use it as it is — same resources, same policy, same budget as every other
              holder — with your own token, below. You cannot change it; its requests are answered
              by its creator alone.
            </p>
          </Banner>
        </div>
      )}

      {orphanExplanation && (
        <Banner
          tone={orphanExplanation.reversible ? 'warning' : 'danger'}
          title={orphanExplanation.title}
        >
          {orphanExplanation.lines.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </Banner>
      )}

      <Card>
        <CardBody>
          <dl className={styles.facts}>
            <dt>Your token</dt>
            <dd>
              {token ? (
                <>
                  <Slug kind="token">{maskedToken(token.prefix)}</Slug>{' '}
                  <span className={styles.muted}>
                    issued <LocalDate ts={token.createdAt} /> — shown once; rotate to replace it
                  </span>
                </>
              ) : (
                'no active token'
              )}
            </dd>
            {!isCreator && (
              <>
                <dt>Creator</dt>
                <dd>{detail.creator.email ?? 'unknown'}</dd>
              </>
            )}
            <dt>Period</dt>
            <dd>{reloadPhrase(detail.period)}</dd>
            <dt>Expiry</dt>
            <dd>{mission.expiresAt ? <LocalDate ts={mission.expiresAt} /> : 'never'}</dd>
            <dt>Created</dt>
            <dd>
              <LocalDate ts={mission.createdAt} />
            </dd>
            {issuedVia && (
              <>
                <dt>Issued by</dt>
                <dd data-testid="issued-via">
                  <Badge tone="info">delegated</Badge> {issuedVia.client_name}, on your behalf —{' '}
                  <Link href={`/delegations#${issuedVia.delegation_id}`}>its delegation</Link>
                  <div className={styles.muted}>
                    Client <Code>{issuedVia.client_id}</Code>. The name is the one the application
                    gave itself; it is not verified. You are the creator of this mission and the
                    only one who answers its requests.
                  </div>
                </dd>
              </>
            )}
          </dl>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Connections and resources</CardTitle>
        </CardHeader>
        <CardBody>
          <dl className={styles.facts}>
            {detail.connections.map((c) => (
              <div key={c.id} style={{ display: 'contents' }}>
                <dt>
                  <Link href={providerPath(c.provider)} className={styles.refLink}>
                    {c.provider_label}
                  </Link>{' '}
                  <Slug kind="connection" mono={false}>
                    {c.display_name}
                  </Slug>{' '}
                  {c.status !== 'active' && <Badge tone="danger">{c.status}</Badge>}
                </dt>
                <dd>
                  {c.resources.length === 0
                    ? 'no resource (account-level tools only)'
                    : c.resources.map((r) => (
                        <span key={r.id}>
                          <Slug kind="resource">{r.ref}</Slug>{' '}
                          {r.env && <Badge mono>{r.env}</Badge>}{' '}
                        </span>
                      ))}
                </dd>
              </div>
            ))}
          </dl>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Policy — {detail.policy.length} accepted risks</CardTitle>
          <span className={styles.muted}>The explicit list this mission carries.</span>
        </CardHeader>
        <Table>
          <Thead>
            <Tr>
              <Th>Risk</Th>
              <Th>Quota</Th>
              <Th>Left this period</Th>
              <Th>Rate limit</Th>
              <Th>Gate</Th>
            </Tr>
          </Thead>
          <Tbody>
            {detail.policy.map((entry) => {
              const risk = explain(entry.risk_id);
              return (
                <Tr key={entry.risk_id} data-testid={`policy-${entry.risk_id}`}>
                  <Td className={styles.policyRisk}>
                    {risk ? (
                      <RiskExplain risk={risk} />
                    ) : (
                      <>
                        {entry.label}
                        <div>
                          <RiskIdLink riskId={entry.risk_id} />
                        </div>
                      </>
                    )}
                  </Td>
                  <Td>{entry.quota}</Td>
                  <Td>{entry.remaining ?? '—'}</Td>
                  <Td className={styles.nowrap}>{formatRate(entry.rate_limit)}</Td>
                  <Td>
                    <div className={styles.gateCell} data-testid={`gate-${entry.risk_id}`}>
                      <GateBadge gate={entry.gate} />
                      {entry.gate_open_until && (
                        <span className={styles.muted}>
                          open until <LocalDate ts={entry.gate_open_until} />
                        </span>
                      )}
                      {gatesEditable && (
                        <GateControl
                          missionId={mission.id}
                          riskId={entry.risk_id}
                          gate={entry.gate}
                        />
                      )}
                    </div>
                  </Td>
                </Tr>
              );
            })}
          </Tbody>
        </Table>
      </Card>

      {team && <TeamSection team={team} />}

      {detail.kit && state.kind === 'active' && (
        <Card>
          <CardHeader>
            <CardTitle>Bootstrap kit</CardTitle>
          </CardHeader>
          <CardBody>
            <BootstrapKitView kit={detail.kit} />
          </CardBody>
        </Card>
      )}
    </Stack>
  );
}
