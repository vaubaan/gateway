/**
 * `/shares` — "Shares received" (spec §4.2): what others entrusted to me,
 * and the exact restriction. A plain list; the restriction unfolds on demand.
 * A share made to a group reaches me while I belong to that group. Several
 * shares of one connection add up: I hold the union of their restrictions.
 */
import Link from 'next/link';

import { NeedsUser } from '@/components/auth/NeedsUser';
import styles from '@/components/connections/connections.module.css';
import { StateBadge } from '@/components/connections/parts';
import {
  Badge,
  Card,
  Stack,
  Table,
  Tbody,
  Td,
  Th,
  Thead,
  Tr,
  type BadgeTone,
} from '@/components/ui';
import { currentActor } from '@/lib/connections/session';
import type { SeverityLevel } from '@/server/missions/model';
import type { ReceivedShare } from '@/server/shares';

export const dynamic = 'force-dynamic';

const LEVEL_TONE: Record<SeverityLevel, BadgeTone> = {
  low: 'neutral',
  medium: 'info',
  high: 'warning',
  critical: 'danger',
};

export default async function SharesReceivedPage() {
  const session = await currentActor();
  if (!session) return <NeedsUser />;
  const received = await session.root.shares.service.received(session.actor);

  return (
    <Stack gap="var(--space-6)">
      <div className={styles.header}>
        <div>
          <h1>Shares received</h1>
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
          {item.connection.displayName}
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
                {risk.level && <Badge tone={LEVEL_TONE[risk.level]}>{risk.level}</Badge>}
                <code className={styles.mono}>{risk.risk_id}</code>
              </span>
            ))}
          </div>
        </details>
      </Td>
      <Td className={styles.muted}>{item.share.createdAt.slice(0, 10)}</Td>
    </Tr>
  );
}
