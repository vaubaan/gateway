/**
 * `/requests` — the inbox: claims and approval requests awaiting me as
 * creator (spec §4.2 "Request inbox", §3.4 "the creator also finds it in
 * their inbox without anyone forwarding anything").
 */
import Link from 'next/link';

import { LocalDate } from '@/components/LocalDate';
import { Badge, Banner, Card, Table, Tbody, Td, Th, Thead, Tr } from '@/components/ui';
import { currentPrincipal } from '@/lib/auth/session';
import { inboxRequestPath } from '@/server/requests/url';

import styles from './requests.module.css';

export const dynamic = 'force-dynamic';

export default async function RequestsPage() {
  const { root, principal } = await currentPrincipal();
  if (principal?.kind !== 'user') {
    return (
      <Banner tone="info" title="No inbox for the bootstrap operator">
        Requests are addressed to the creator of a mission, and a mission is issued by an identified
        user. Sign in through the identity provider to see yours.
      </Banner>
    );
  }
  const requests = await root.requests.service.inbox(principal.user);

  return (
    <>
      <div className={styles.pageHead}>
        <div>
          <h1>Requests</h1>
          <p className={styles.muted}>
            What your missions ask of you: a claim when a budget is exhausted. Only you can answer.
          </p>
        </div>
      </div>
      <Card>
        {requests.length === 0 ? (
          <div className={styles.empty}>Nothing awaits you.</div>
        ) : (
          <Table>
            <Thead>
              <Tr>
                <Th>Request</Th>
                <Th>Mission</Th>
                <Th>Risk</Th>
                <Th>Asked</Th>
                <Th>Expires</Th>
              </Tr>
            </Thead>
            <Tbody>
              {requests.map((request) => (
                <Tr key={request.id}>
                  <Td>
                    <Link href={inboxRequestPath(request.id)} className={styles.rowLink}>
                      {request.kind === 'claim' ? 'Claim' : 'Approval request'}
                    </Link>{' '}
                    <Badge tone="warning">{request.state}</Badge>
                  </Td>
                  <Td>
                    <Link href={`/missions/${request.mission.id}`}>{request.mission.name}</Link>
                  </Td>
                  <Td>
                    {request.risk_label}
                    <div className={styles.mono}>{request.risk_id}</div>
                  </Td>
                  <Td>
                    <LocalDate ts={request.created_at} />
                  </Td>
                  <Td>
                    <LocalDate ts={request.expires_at} />
                  </Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        )}
      </Card>
    </>
  );
}
