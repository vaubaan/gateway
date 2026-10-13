/**
 * `/missions` — my missions, their state, their token prefix (spec §4.2).
 */
import Link from 'next/link';

import { LocalDate } from '@/components/LocalDate';
import { NeedsUser } from '@/components/auth/NeedsUser';
import { Card, Code, Table, Tbody, Td, Th, Thead, Tr } from '@/components/ui';
import { currentUser } from '@/lib/auth/session';
import { maskedToken } from '@/server/missions';

import styles from './missions.module.css';
import { StateBadge } from './state-badge';

export const dynamic = 'force-dynamic';

export default async function MissionsPage() {
  const session = await currentUser();
  if (!session) return <NeedsUser />;
  const missions = await session.root.missions.service.list(session.user);

  return (
    <>
      <div className={styles.pageHead}>
        <div>
          <h1>Missions</h1>
          <p className={styles.muted}>
            A mission is a named objective with a token: selected resources, accepted risks, a
            budget.
          </p>
        </div>
        <Link href="/missions/new" className={styles.primaryLink}>
          New mission
        </Link>
      </div>
      <Card>
        {missions.length === 0 ? (
          <div className={styles.empty}>
            No mission yet. <Link href="/missions/new">Issue the first one</Link>.
          </div>
        ) : (
          <Table>
            <Thead>
              <Tr>
                <Th>Name</Th>
                <Th>State</Th>
                <Th>Connections</Th>
                <Th>Risks</Th>
                <Th>Token</Th>
                <Th>Created</Th>
                <Th>Expires</Th>
              </Tr>
            </Thead>
            <Tbody>
              {missions.map(({ mission, state, token }) => (
                <Tr key={mission.id}>
                  <Td>
                    <Link href={`/missions/${mission.id}`} className={styles.rowLink}>
                      {mission.name}
                    </Link>
                  </Td>
                  <Td>
                    <StateBadge state={state} />
                  </Td>
                  <Td>{mission.connections.length}</Td>
                  <Td>{mission.policy.length}</Td>
                  <Td>{token ? <Code>{maskedToken(token.prefix)}</Code> : '—'}</Td>
                  <Td>
                    <LocalDate ts={mission.createdAt} dateOnly />
                  </Td>
                  <Td>{mission.expiresAt ? <LocalDate ts={mission.expiresAt} /> : 'never'}</Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        )}
      </Card>
    </>
  );
}
