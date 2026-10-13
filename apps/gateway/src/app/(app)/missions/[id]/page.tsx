/**
 * `/missions/<id>` — one mission: state, connections and resources, policy
 * per risk with what is left this period, token prefix with Rotate, the
 * bootstrap kit with the secret masked (spec §4.2, §4.4), and the link to the
 * mission's session page.
 */
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { LocalDate } from '@/components/LocalDate';
import {
  Badge,
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
} from '@/components/ui';
import { maskedToken } from '@/server/missions';
import { reloadPhrase } from '@/server/missions/summary';

import { BootstrapKitView } from '../bootstrap-kit-view';
import { currentUser } from '../current-user';
import { NeedsUser } from '../needs-user';
import styles from '../missions.module.css';
import { StateBadge } from '../state-badge';
import { MissionActions } from './mission-actions';

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
  const { mission, state, token } = detail;

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
          <MissionActions
            missionId={mission.id}
            name={mission.name}
            active={state.kind === 'active'}
          />
        </div>
      </div>

      <Card>
        <CardBody>
          <dl className={styles.facts}>
            <dt>Token</dt>
            <dd>
              {token ? (
                <>
                  <Code>{maskedToken(token.prefix)}</Code>{' '}
                  <span className={styles.muted}>
                    issued <LocalDate ts={token.createdAt} /> — shown once; rotate to replace it
                  </span>
                </>
              ) : (
                'no active token'
              )}
            </dd>
            <dt>Period</dt>
            <dd>{reloadPhrase(detail.period)}</dd>
            <dt>Expiry</dt>
            <dd>{mission.expiresAt ? <LocalDate ts={mission.expiresAt} /> : 'never'}</dd>
            <dt>Created</dt>
            <dd>
              <LocalDate ts={mission.createdAt} />
            </dd>
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
                  {c.provider_label} “{c.display_name}”{' '}
                  {c.status !== 'active' && <Badge tone="danger">{c.status}</Badge>}
                </dt>
                <dd>
                  {c.resources.length === 0
                    ? 'no resource (account-level tools only)'
                    : c.resources.map((r) => (
                        <span key={r.id}>
                          <Code>{r.ref}</Code> {r.env && <Badge mono>{r.env}</Badge>}{' '}
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
            {detail.policy.map((entry) => (
              <Tr key={entry.risk_id}>
                <Td>
                  {entry.label}
                  <div className={styles.mono}>{entry.risk_id}</div>
                </Td>
                <Td>{entry.quota}</Td>
                <Td>{entry.remaining ?? '—'}</Td>
                <Td>
                  {entry.rate_limit.max} per {entry.rate_limit.window_seconds}s
                </Td>
                <Td>
                  {entry.gate === 'approval' ? <Badge tone="warning">approval</Badge> : 'auto'}
                </Td>
              </Tr>
            ))}
          </Tbody>
        </Table>
      </Card>

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
