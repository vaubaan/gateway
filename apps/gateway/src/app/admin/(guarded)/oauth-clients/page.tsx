/**
 * `/admin/oauth-clients` — the applications that may ask users for a
 * delegation on the management door (spec §4.1 bis): every registered OAuth
 * client, what the registration policy says of it, and the operator's
 * decision. Approving lets the client reach a consent screen; disabling bars
 * it and revokes every delegation it holds.
 */
import { LocalDate } from '@/components/LocalDate';
import styles from '@/components/auth/auth.module.css';
import {
  Badge,
  Banner,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Code,
  Stack,
  type BadgeTone,
} from '@/components/ui';
import { requireOperator } from '@/lib/auth/session';
import { firstParam, type PageSearchParams } from '@/lib/connections/session';
import {
  OAUTH_CLIENTS_PAGE,
  redirectDestination,
  type ClientStatus,
  type ClientView,
} from '@/server/oauth-as';

export const dynamic = 'force-dynamic';

const STATUS: Readonly<Record<ClientStatus, { label: string; tone: BadgeTone }>> = {
  approved: { label: 'approved', tone: 'success' },
  pending: { label: 'waiting for approval', tone: 'warning' },
  disabled: { label: 'disabled', tone: 'danger' },
};

const POLICY: Readonly<Record<string, string>> = {
  open: 'open — any application that registers may ask users for a delegation at once',
  'operator-approved':
    'operator-approved — an application waits for your approval before it can ask anyone',
  closed: 'closed — no application registers; only those you approved are usable',
};

function ClientCard({ view }: { view: ClientView }) {
  const { client, status } = view;
  const badge = STATUS[status];
  const action = `${OAUTH_CLIENTS_PAGE}/${encodeURIComponent(client.id)}`;
  return (
    <Card id={client.id}>
      <CardHeader>
        <CardTitle>{client.name}</CardTitle>
        <span style={{ display: 'inline-flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
          <Badge tone={badge.tone}>{badge.label}</Badge>
          <Badge>{view.decidedBy === 'operator' ? 'decided by an operator' : 'by policy'}</Badge>
          {view.loopbackOnly && <Badge tone="info">this-computer only</Badge>}
        </span>
      </CardHeader>
      <CardBody>
        <Stack gap="var(--space-4)">
          <dl className={styles.dl}>
            <dt>Name</dt>
            <dd>
              {client.name}{' '}
              <span className={styles.muted}>(declared by the application, not verified)</span>
            </dd>
            <dt>Client id</dt>
            <dd>
              <Code>{client.clientId}</Code>
            </dd>
            <dt>Registered</dt>
            <dd>
              <LocalDate ts={client.createdAt} />{' '}
              {client.registration === 'metadata-document'
                ? 'from its metadata document'
                : 'by dynamic registration'}
              {client.tokenEndpointAuthMethod === 'none'
                ? ', public client'
                : ', confidential client'}
            </dd>
            <dt>Sends access to</dt>
            <dd>
              {client.redirectUris.map((uri) => {
                const destination = redirectDestination(uri);
                return (
                  <div key={uri}>
                    <Code>{uri}</Code>{' '}
                    {destination?.kind === 'web' && <Badge tone="warning">a server</Badge>}
                    {destination?.kind === 'app-scheme' && <Badge>an application link</Badge>}
                  </div>
                );
              })}
            </dd>
            {client.clientUri && (
              <>
                <dt>Home page</dt>
                <dd>
                  <Code>{client.clientUri}</Code>
                </dd>
              </>
            )}
            {client.decidedAt && (
              <>
                <dt>Decided</dt>
                <dd>
                  <LocalDate ts={client.decidedAt} />
                </dd>
              </>
            )}
          </dl>
          <form method="post" action={action}>
            <span style={{ display: 'inline-flex', gap: 'var(--space-2)' }}>
              {status !== 'approved' && (
                <Button type="submit" name="action" value="approve" variant="primary" size="sm">
                  Approve
                </Button>
              )}
              {status !== 'disabled' && (
                <Button type="submit" name="action" value="disable" variant="danger" size="sm">
                  Disable and revoke its delegations
                </Button>
              )}
            </span>
          </form>
        </Stack>
      </CardBody>
    </Card>
  );
}

export default async function OAuthClientsPage({
  searchParams,
}: {
  searchParams: PageSearchParams;
}) {
  const { root } = await requireOperator();
  const params = await searchParams;
  const views = await root.oauth.clients.list();
  const registration = root.config.oauth.clientRegistration;
  const decided = firstParam(params.decided);

  return (
    <Stack gap="var(--space-6)">
      <div>
        <h1>OAuth clients</h1>
        <p className={styles.muted}>
          Applications (MCP clients such as coding agents) that registered to ask users for a
          delegation on the management door. Whatever is decided here, a user still signs in and
          consents on a screen naming the application before it receives anything.
        </p>
        <p className={styles.muted}>
          Registration policy: {POLICY[registration.policy] ?? registration.policy}
          {registration.policy === 'operator-approved' &&
            (registration.autoApproveLoopback
              ? '; an application that can only send access back to the user’s own computer needs no approval.'
              : '; every application, without exception.')}{' '}
          Set by <code>oauth.client_registration</code> in the instance configuration.
        </p>
      </div>

      {decided === 'approved' && (
        <Banner tone="success" title="Client approved">
          It can now ask users for a delegation.
        </Banner>
      )}
      {decided === 'disabled' && (
        <Banner tone="success" title="Client disabled">
          Its delegations were revoked; each revocation is in the audit.
        </Banner>
      )}
      {firstParam(params.problem) === 'not-found' && (
        <Banner tone="warning" title="No such client">
          This client is not registered on this instance.
        </Banner>
      )}

      {views.length === 0 ? (
        <Card>
          <CardBody>No application registered yet.</CardBody>
        </Card>
      ) : (
        views.map((view) => <ClientCard key={view.client.id} view={view} />)
      )}
    </Stack>
  );
}
