/**
 * `/missions` — the missions I created and the ones shared with me as a member
 * (spec §4.2), their state, the prefix of my own token on each. A mission an
 * agent issued on my behalf through the management door is marked with the
 * application that issued it (spec §2.4, §7.10).
 */
import Link from 'next/link';

import { LocalDate } from '@/components/LocalDate';
import { NeedsUser } from '@/components/auth/NeedsUser';
import { Badge, Card, Code, Table, Tbody, Td, Th, Thead, Tr } from '@/components/ui';
import { currentUser } from '@/lib/auth/session';
import { maskedToken, type MissionOverview } from '@/server/missions';

import styles from './missions.module.css';
import { StateBadge } from './state-badge';

export const dynamic = 'force-dynamic';

export default async function MissionsPage() {
  const session = await currentUser();
  if (!session) return <NeedsUser />;
  const missions = await session.root.missions.service.list(session.user);
  const created = missions.filter((m) => m.role === 'creator');
  const shared = missions.filter((m) => m.role === 'member');

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
      <h2 className={styles.listTitle}>Created by me</h2>
      <Card data-testid="missions-created">
        {created.length === 0 ? (
          <div className={styles.empty}>
            No mission yet. <Link href="/missions/new">Issue the first one</Link>.
          </div>
        ) : (
          <MissionTable missions={created} shared={false} />
        )}
      </Card>

      <h2 className={styles.listTitle}>Shared with me</h2>
      <Card data-testid="missions-shared">
        {shared.length === 0 ? (
          <div className={styles.empty}>
            No mission is shared with you. The creator of a mission adds members on its page; a
            member works on it with their own token.
          </div>
        ) : (
          <MissionTable missions={shared} shared />
        )}
      </Card>
    </>
  );
}

function MissionTable({
  missions,
  shared,
}: {
  missions: readonly MissionOverview[];
  /** Missions of other creators: the creator is named, and the token is "my token". */
  shared: boolean;
}) {
  return (
    <Table>
      <Thead>
        <Tr>
          <Th>Name</Th>
          {shared && <Th>Creator</Th>}
          <Th>State</Th>
          <Th>Connections</Th>
          <Th>Risks</Th>
          <Th>My token</Th>
          <Th>Created</Th>
          <Th>Expires</Th>
        </Tr>
      </Thead>
      <Tbody>
        {missions.map(({ mission, state, token, issuedVia, creator }) => (
          <Tr key={mission.id}>
            <Td>
              <Link href={`/missions/${mission.id}`} className={styles.rowLink}>
                {mission.name}
              </Link>
              {issuedVia && (
                <div className={styles.muted} data-testid={`issued-via-${mission.id}`}>
                  <Badge tone="info">delegated</Badge> issued by {issuedVia.client_name}
                </div>
              )}
            </Td>
            {shared && <Td>{creator.email ?? 'unknown'}</Td>}
            <Td>
              <StateBadge state={state} />
            </Td>
            <Td>{mission.connections.length}</Td>
            <Td>{mission.policy.length}</Td>
            <Td>
              {token ? (
                <Code>{maskedToken(token.prefix)}</Code>
              ) : shared ? (
                <span className={styles.muted}>not generated yet</span>
              ) : (
                '—'
              )}
            </Td>
            <Td>
              <LocalDate ts={mission.createdAt} dateOnly />
            </Td>
            <Td>{mission.expiresAt ? <LocalDate ts={mission.expiresAt} /> : 'never'}</Td>
          </Tr>
        ))}
      </Tbody>
    </Table>
  );
}
