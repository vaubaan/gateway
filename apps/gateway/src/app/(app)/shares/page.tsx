/**
 * `/shares` — "Shares received" (spec §4.2): what others entrusted to me,
 * and the exact restriction. A plain list; the restriction unfolds on demand.
 * A share made to a group reaches me while I belong to that group. Several
 * shares of one connection add up: I hold the union of their restrictions.
 */
import Link from 'next/link';
import { PAGES, ROUTES, SECTIONS } from '@/lib/vocabulary';

import { NeedsUser } from '@/components/auth/NeedsUser';
import styles from '@/components/connections/connections.module.css';
import { StateBadge } from '@/components/connections/parts';
import { SeverityBadge } from '@/components/risk/RiskBadges';
import { RiskIdLink } from '@/components/risk/RiskExplain';
import { LocalDate } from '@/components/LocalDate';
import { Card, Slug, Stack, Table, Tbody, Td, Th, Thead, Tr } from '@/components/ui';
import { currentActor } from '@/lib/connections/session';
import type { ReceivedShare } from '@/server/shares';

export const dynamic = 'force-dynamic';

export default async function SharesReceivedPage() {
  const session = await currentActor();
  if (!session) return <NeedsUser />;
  const received = await session.root.shares.service.received(session.actor);

  return (
    <Stack gap="var(--space-6)">
      <div className={styles.header}>
        <div>
          <p className={styles.muted}>
            <Link href={ROUTES.accounts}>{PAGES.accounts.title}</Link> / {SECTIONS.sharedWithYou}
          </p>
          <h1>{SECTIONS.sharedWithYou}</h1>
          <p className={styles.muted}>
            Connections others shared with you. In your missions on such a connection you may accept
            the risks listed here and nothing beyond; when several shares cover one connection, you
            hold all of their risks together.
          </p>
        </div>
        {received.length > 0 && (
          <Link href="/missions/new" className={styles.linkButton}>
            Issue a mission
          </Link>
        )}
      </div>

      <Card>
        {received.length === 0 ? (
          <div className={styles.empty}>Nobody has shared a connection with you yet.</div>
        ) : (
          <div className={styles.tableWrap}>
            <Table>
              <Thead>
                <Tr>
                  <Th>Connection</Th>
                  <Th>Owner</Th>
                  <Th>Shared with</Th>
                  <Th>Restriction</Th>
                  <Th>Since</Th>
                </Tr>
              </Thead>
              <Tbody>
                {received.map((item) => (
                  <ReceivedRow key={item.share.id} item={item} />
                ))}
              </Tbody>
            </Table>
          </div>
        )}
      </Card>
    </Stack>
  );
}

function ReceivedRow({ item }: { item: ReceivedShare }) {
  const count = item.risks.length;
  return (
    <Tr>
      <Td>
        <span className={styles.badges}>
          <Slug kind="connection" mono={false}>
            {item.connection.displayName}
          </Slug>
          <span className={styles.muted}>{item.providerLabel}</span>
          {item.connection.status !== 'active' && <StateBadge status={item.connection.status} />}
        </span>
      </Td>
      <Td>{item.ownerLabel}</Td>
      <Td>{item.via}</Td>
      <Td>
        <details className={styles.settings}>
          <summary>
            {count} {count === 1 ? 'risk' : 'risks'}
          </summary>
          <div className={styles.settingsBody}>
            {item.risks.map((risk) => (
              <span key={risk.risk_id} className={styles.badges}>
                {risk.known ? risk.label : 'No longer in the catalog'}
                {risk.level && <SeverityBadge level={risk.level} />}
                <RiskIdLink riskId={risk.risk_id} />
              </span>
            ))}
          </div>
        </details>
      </Td>
      <Td className={styles.muted}>
        <LocalDate ts={item.share.createdAt} />
      </Td>
    </Tr>
  );
}
