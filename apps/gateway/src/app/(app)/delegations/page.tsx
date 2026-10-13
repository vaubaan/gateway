/**
 * `/delegations` — the agents I authorized to manage my missions (spec §4.2
 * "Delegations", §4.1 bis): the client holding each delegation, the day its
 * absolute lifetime ends, the missions it issued in my name, and its
 * revocation in one click.
 */

import { LocalDate } from '@/components/LocalDate';
import { NeedsUser } from '@/components/auth/NeedsUser';
import {
  Badge,
  Banner,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Code,
  Slug,
  Stack,
  type BadgeTone,
} from '@/components/ui';
import { currentUser } from '@/lib/auth/session';
import { firstParam, type PageSearchParams } from '@/lib/connections/session';
import {
  DELEGATIONS_PAGE,
  redirectDestination,
  type DelegationState,
  type DelegationView,
} from '@/server/oauth-as';
import type { DelegationRevokeReason } from '@/server/store/types';

import styles from './delegations.module.css';

export const dynamic = 'force-dynamic';

const STATE: Readonly<Record<DelegationState, { label: string; tone: BadgeTone }>> = {
  active: { label: 'active', tone: 'success' },
  idle: { label: 'idle', tone: 'neutral' },
  expired: { label: 'expired', tone: 'warning' },
  revoked: { label: 'revoked', tone: 'danger' },
};

const SECONDS_PER_DAY = 86_400;
const SECONDS_PER_HOUR = 3_600;

/** A lifetime in the largest unit that says it exactly enough: days, else hours. */
function lifetimeInWords(seconds: number): string {
  if (seconds >= SECONDS_PER_DAY) {
    const days = Math.round(seconds / SECONDS_PER_DAY);
    return `${days} ${days === 1 ? 'day' : 'days'}`;
  }
  const hours = Math.max(1, Math.round(seconds / SECONDS_PER_HOUR));
  return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
}

const REVOKE_REASON: Readonly<Record<DelegationRevokeReason, string>> = {
  user: 'revoked by you',
  client: 'ended by the application (it signed out)',
  operator: 'revoked by an operator, who disabled the application',
  'user-deactivated': 'revoked by an operator, who deactivated your account',
  'refresh-token-replay':
    'revoked by the gateway: a refresh token that had already been used was presented again, which means two parties held it',
  'authorization-code-replay':
    'revoked by the gateway: its authorization code was presented twice, which means two parties held it',
};

/** Where the application receives its access, one label per distinct destination. */
function destinations(view: DelegationView): string[] {
  const labels = view.client.redirectUris.map((uri) => redirectDestination(uri)?.label ?? uri);
  return [...new Set(labels)];
}

function DelegationCard({ view, lifetime }: { view: DelegationView; lifetime: string }) {
  const { delegation, client, state, missions } = view;
  const badge = STATE[state];
  return (
    <Card id={delegation.id}>
      <CardHeader>
        <CardTitle>{client.name}</CardTitle>
        <span className={styles.badges}>
          <Badge tone={badge.tone}>{badge.label}</Badge>
          {view.clientStatus === 'disabled' && <Badge tone="danger">application disabled</Badge>}
        </span>
      </CardHeader>
      <CardBody>
        <Stack gap="var(--space-4)">
          <dl className={styles.facts}>
            <dt>Application</dt>
            <dd>
              {client.name}
              <div className={styles.muted}>
                The name the application gave itself; it is not verified.
              </div>
            </dd>
            <dt>Client id</dt>
            <dd>
              <Code>{client.clientId}</Code>
            </dd>
            <dt>Access goes to</dt>
            <dd>
              {destinations(view).map((label) => (
                <div key={label}>
                  <Code>{label}</Code>
                </div>
              ))}
            </dd>
            <dt>Permission</dt>
            <dd>
              <Code>{delegation.scope}</Code> — mission management, in your name
            </dd>
            <dt>Granted</dt>
            <dd>
              <LocalDate ts={delegation.createdAt} />
            </dd>
            <dt>Last renewed</dt>
            <dd>{view.lastTokenAt ? <LocalDate ts={view.lastTokenAt} /> : 'never used'}</dd>
            {state === 'active' && (
              <>
                <dt>Ends if unused</dt>
                <dd>
                  <LocalDate ts={view.liveUntil} /> unless the application renews it before
                </dd>
              </>
            )}
            {(state === 'active' || state === 'idle') && (
              <>
                <dt>Consent ends</dt>
                <dd>
                  <LocalDate ts={view.expiresAt} /> — {lifetime} after you granted it. The
                  application will then have to ask you again, however recently it renewed.
                </dd>
              </>
            )}
            {state === 'expired' && (
              <>
                <dt>Expired</dt>
                <dd>
                  <LocalDate ts={view.expiresAt} /> — a delegation lasts {lifetime}. The application
                  can no longer act on your behalf; it must ask you for your consent again.
                </dd>
              </>
            )}
            {state === 'idle' && (
              <>
                <dt>State</dt>
                <dd>
                  No token of this delegation is valid any more: the application must ask you again.
                </dd>
              </>
            )}
            {state === 'revoked' && (
              <>
                <dt>Revoked</dt>
                <dd>
                  <LocalDate ts={delegation.revokedAt} />
                  {delegation.revokeReason && <> — {REVOKE_REASON[delegation.revokeReason]}</>}
                </dd>
              </>
            )}
          </dl>

          {view.replayed && (
            <Banner
              tone={view.toReview.length > 0 ? 'danger' : 'warning'}
              title={
                view.toReview.length > 0
                  ? `Review ${view.toReview.length === 1 ? 'the mission' : `the ${view.toReview.length} missions`} this delegation issued`
                  : 'A token of this delegation was held by two parties'
              }
            >
              {view.toReview.length > 0 ? (
                <>
                  <p>
                    The gateway revoked this delegation because one of its tokens was presented
                    twice: somebody other than the application may have held it, and may have issued
                    missions in your name. The missions below are still running and were{' '}
                    <strong>not</strong> revoked. Open each one: revoke those you do not recognise,
                    and rotate the token of those you keep.
                  </p>
                  <ul className={styles.missions} aria-label="Missions to review">
                    {view.toReview.map((mission) => (
                      <li key={mission.id}>
                        <Slug kind="mission" mono={false} href={`/missions/${mission.id}`}>
                          {mission.name}
                        </Slug>{' '}
                        <Badge>{mission.status}</Badge>
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <p>
                  The gateway revoked this delegation because one of its tokens was presented twice.
                  None of the missions it issued is still running.
                </p>
              )}
            </Banner>
          )}

          <div>
            <h3 className={styles.sub}>Missions it issued</h3>
            {missions.length === 0 ? (
              <p className={styles.muted}>None.</p>
            ) : (
              <ul className={styles.missions}>
                {missions.map((mission) => (
                  <li key={mission.id}>
                    <Slug kind="mission" mono={false} href={`/missions/${mission.id}`}>
                      {mission.name}
                    </Slug>{' '}
                    <Badge>{mission.status}</Badge>{' '}
                    <span className={styles.muted}>
                      issued in your name <LocalDate ts={mission.createdAt} />
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {state !== 'revoked' && (
            <form
              method="post"
              action={`${DELEGATIONS_PAGE}/${encodeURIComponent(delegation.id)}/revoke`}
            >
              <Button type="submit" variant="danger" size="sm">
                Revoke
              </Button>{' '}
              <span className={styles.muted}>
                The application loses its access at once. The missions it issued are yours and stay.
              </span>
            </form>
          )}
        </Stack>
      </CardBody>
    </Card>
  );
}

export default async function DelegationsPage({
  searchParams,
}: {
  searchParams: PageSearchParams;
}) {
  const session = await currentUser();
  if (!session) return <NeedsUser />;
  const params = await searchParams;
  const views = await session.root.oauth.delegations.listFor(session.user);
  const door = session.root.oauth.endpoints.resource;
  const lifetime = lifetimeInWords(session.root.config.oauth.delegationMaxLifetimeSeconds);

  return (
    <Stack gap="var(--space-4)">
      <div>
        <h1>Delegations</h1>
        <p className={styles.muted}>
          The applications you authorized to manage your missions on your behalf, through the
          management door <Code>{door}</Code>. A delegated application can read your connections and
          missions, issue missions in your name, rotate the token of the missions it issued and
          revoke any of your missions; it can never answer a request, touch a connection or call a
          provider. A delegation lasts {lifetime} at most: after that the application asks for your
          consent again.
        </p>
      </div>

      {firstParam(params.revoked) && (
        <Banner tone="success" title="Delegation revoked">
          The application can no longer act on your behalf.
        </Banner>
      )}
      {firstParam(params.problem) === 'not-found' && (
        <Banner tone="warning" title="No such delegation">
          This delegation does not exist among yours.
        </Banner>
      )}

      {views.length === 0 ? (
        <Card>
          <div className={styles.empty}>
            You authorized no application. Point an MCP client at <Code>{door}</Code>: it will send
            you here to sign in and consent.
          </div>
        </Card>
      ) : (
        views.map((view) => (
          <DelegationCard key={view.delegation.id} view={view} lifetime={lifetime} />
        ))
      )}
    </Stack>
  );
}
