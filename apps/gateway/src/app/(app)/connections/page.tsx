/**
 * `/connections` — my connections and their state (spec §4.2 "Connections").
 * A connection is listed for its owner: the user who connected it, or a
 * member of the group that owns it.
 */
import Link from 'next/link';

import { NeedsUser } from '@/components/auth/NeedsUser';
import styles from '@/components/connections/connections.module.css';
import { ExperimentalBadge, NoticeBanner, StateBadge } from '@/components/connections/parts';
import { ValidationBadge } from '@/components/telemetry/ValidationBadge';
import { Card, Stack, Table, Tbody, Td, Th, Thead, Tr } from '@/components/ui';
import { currentActor, takeNotice, type PageSearchParams } from '@/lib/connections/session';
import { connectionPath, NEW_CONNECTION_PATH } from '@/server/connections';

export const dynamic = 'force-dynamic';

export default async function ConnectionsPage({
  searchParams,
}: {
  searchParams: PageSearchParams;
}) {
  const session = await currentActor();
  if (!session) return <NeedsUser />;
  const { root, principal, actor } = session;
  const notice = await takeNotice(root, principal.sessionId, await searchParams);
  const connections = await root.connections.service.listFor(actor);
  // Community validation status per provider (spec §9); empty when telemetry is off.
  const validation = new Map(
    await Promise.all(
      [...new Set(connections.map((view) => view.connection.provider))].map(
        async (provider) => [provider, await root.telemetry.stats.statusFor(provider)] as const,
      ),
    ),
  );

  return (
    <Stack gap="var(--space-6)">
      <div className={styles.header}>
        <div>
          <h1>Connections</h1>
          <p className={styles.muted}>
            A connection is a provider you authenticated into this instance. Its credential is
            encrypted at rest and never leaves the gateway; missions are issued on top of it.
          </p>
        </div>
        <Link href={NEW_CONNECTION_PATH} className={styles.linkButton}>
          Connect a provider
        </Link>
      </div>

      <NoticeBanner notice={notice} />

      <Card>
        {connections.length === 0 ? (
          <div className={styles.empty}>
            No connection yet. <Link href={NEW_CONNECTION_PATH}>Connect a provider</Link> to start.
          </div>
        ) : (
          <div className={styles.tableWrap}>
            <Table>
              <Thead>
                <Tr>
                  <Th>Name</Th>
                  <Th>Provider</Th>
                  <Th>State</Th>
                  <Th>Owner</Th>
                  <Th>Connected</Th>
                </Tr>
              </Thead>
              <Tbody>
                {connections.map((view) => (
                  <Tr key={view.connection.id}>
                    <Td>
                      <Link href={connectionPath(view.connection.id)}>
                        {view.connection.displayName}
                      </Link>
                    </Td>
                    <Td>
                      <span className={styles.badges}>
                        {view.providerLabel}
                        {view.experimental && <ExperimentalBadge />}
                        <ValidationBadge
                          status={validation.get(view.connection.provider) ?? null}
                        />
                      </span>
                    </Td>
                    <Td>
                      <StateBadge status={view.connection.status} />
                    </Td>
                    <Td>{view.ownerLabel}</Td>
                    <Td className={styles.muted}>{view.connection.createdAt.slice(0, 10)}</Td>
                  </Tr>
                ))}
              </Tbody>
            </Table>
          </div>
        )}
      </Card>
    </Stack>
  );
}
