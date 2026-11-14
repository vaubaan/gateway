/**
 * `/settings/connected-apps` — the apps a person allowed to prepare missions
 * in their name (spec §4.2 "Delegations", §4.1 bis): which app, until when
 * its consent runs, the missions it prepared, and its disconnection, asked
 * first.
 *
 * A connected app is a delegation held by an OAuth client. `?app=<id>` unfolds
 * the facts of one: the id the app registered under, where it receives its
 * access, when it last renewed.
 *
 * Nothing is created here: an app connects itself when its MCP client is
 * pointed at the management door, and the person consents. The page's one
 * action leads to the region that says how.
 */
import Link from 'next/link';

import { LocalDate } from '@/components/LocalDate';
import { NeedsUser } from '@/components/auth/NeedsUser';
import styles from '@/components/settings/settings.module.css';
import {
  ButtonLink,
  Callout,
  CodeBlock,
  ConfirmSubmit,
  DataTable,
  EmptyState,
  Hint,
  KeyValue,
  Mono,
  PageHeader,
  Section,
  StatusMark,
  type Column,
} from '@/components/ui';
import { currentUser } from '@/lib/auth/session';
import { firstParam, type PageSearchParams } from '@/lib/connections/session';
import {
  DOC_PAGES,
  APP_END_WORDS,
  APP_STATES,
  count,
  formatNumber,
  MISSION_STATES,
  ROUTES,
  SETTINGS_ACTIONS,
  SETTINGS_PAGES,
  shortDate,
  TERMS,
} from '@/lib/vocabulary';
import { DELEGATIONS_PAGE, redirectDestination, type DelegationView } from '@/server/oauth-as';

export const dynamic = 'force-dynamic';

/** The query parameter that unfolds the facts of one app. */
const APP_PARAM = 'app';
/** The region that says how an app connects. */
const CONNECT_ANCHOR = 'connect';
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

/** Where the app receives its access, one label per distinct destination. */
function destinations(view: DelegationView): string[] {
  const labels = view.client.redirectUris.map((uri) => redirectDestination(uri)?.label ?? uri);
  return [...new Set(labels)];
}

function missionWord(status: string): string {
  if (status === 'active') return MISSION_STATES.active.label;
  if (status === 'revoked') return MISSION_STATES.revoked.label;
  if (status === 'expired') return MISSION_STATES.expired.label;
  return status;
}

function AppDetail({ view, lifetime }: { view: DelegationView; lifetime: string }) {
  const { delegation, client, state } = view;
  return (
    <div className={styles.detail} data-testid="app-detail">
      <KeyValue
        items={[
          {
            term: 'App',
            value: (
              <>
                {client.name}{' '}
                <span className={styles.quiet}>· the name it gave itself; not verified</span>
              </>
            ),
          },
          { term: 'Registered as', value: <Mono>{client.clientId}</Mono> },
          {
            term: 'Its access goes to',
            value: (
              <span className={styles.inline}>
                {destinations(view).map((label) => (
                  <Mono key={label}>{label}</Mono>
                ))}
              </span>
            ),
          },
          {
            term: 'May',
            value: (
              <>
                prepare and manage your missions, in your name <Mono quiet>{delegation.scope}</Mono>
              </>
            ),
          },
          { term: 'Connected', value: <LocalDate ts={delegation.createdAt} /> },
          {
            term: 'Last renewed',
            value: view.lastTokenAt ? <LocalDate ts={view.lastTokenAt} /> : 'never used',
          },
          ...(state === 'active' && view.liveUntil
            ? [
                {
                  term: 'Ends if unused',
                  value: (
                    <>
                      <LocalDate ts={view.liveUntil} />, unless the app renews before
                    </>
                  ),
                },
              ]
            : []),
          ...(state === 'active' || state === 'idle'
            ? [
                {
                  term: 'Consent ends',
                  value: (
                    <>
                      <LocalDate ts={view.expiresAt} /> — {lifetime} after you gave it. The app then
                      asks you again, however recently it renewed.
                    </>
                  ),
                },
              ]
            : []),
          ...(state === 'expired'
            ? [
                {
                  term: 'Consent ended',
                  value: (
                    <>
                      <LocalDate ts={view.expiresAt} /> — a consent lasts {lifetime}. The app can no
                      longer act for you; it must ask you again.
                    </>
                  ),
                },
              ]
            : []),
          ...(state === 'idle'
            ? [
                {
                  term: 'Now',
                  value: 'No token of it is valid any more: the app must ask you again.',
                },
              ]
            : []),
          ...(state === 'revoked'
            ? [
                {
                  term: 'Disconnected',
                  value: (
                    <>
                      <LocalDate ts={delegation.revokedAt} />
                      {delegation.revokeReason && <> — {APP_END_WORDS[delegation.revokeReason]}</>}
                    </>
                  ),
                },
              ]
            : []),
        ]}
      />
      {view.missions.length > 0 && (
        <div>
          <p className={styles.quiet}>Missions it prepared, in your name:</p>
          <ul className={styles.members}>
            {view.missions.map((mission) => (
              <li key={mission.id}>
                <Link href={`${ROUTES.missions}/${mission.id}`} className={styles.reveal}>
                  {mission.name}
                </Link>{' '}
                <span className={styles.quiet}>
                  · {missionWord(mission.status)} · <LocalDate ts={mission.createdAt} dateOnly />
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export default async function ConnectedAppsPage({
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
  const unfolded = firstParam(params[APP_PARAM]);
  const now = new Date();
  const replayed = views.filter((view) => view.replayed);

  const columns: readonly Column<DelegationView>[] = [
    {
      id: 'app',
      header: 'App',
      cell: (view) => {
        const open = unfolded === view.delegation.id;
        const query = open ? '' : `?${APP_PARAM}=${encodeURIComponent(view.delegation.id)}`;
        return (
          <span className={styles.namedText} id={view.delegation.id}>
            <Link
              href={`${DELEGATIONS_PAGE}${query}`}
              scroll={false}
              aria-expanded={open}
              className={styles.name}
              data-testid={`app-${view.delegation.id}`}
            >
              {view.client.name}
            </Link>
            <span className={styles.sub}>
              consent given {shortDate(view.delegation.createdAt, now)} · valid {lifetime}
            </span>
          </span>
        );
      },
    },
    {
      id: 'state',
      header: 'State',
      nowrap: true,
      cell: (view) =>
        view.replayed ? (
          <StatusMark tone="bad">
            {view.toReview.length > 0 ? 'Review its missions' : 'Disconnected by the gateway'}
          </StatusMark>
        ) : view.clientStatus === 'disabled' ? (
          <StatusMark tone="bad">Disabled by an administrator</StatusMark>
        ) : (
          <span className={view.state === 'active' ? undefined : styles.quiet}>
            {APP_STATES[view.state].label}
            {view.state === 'revoked' && view.delegation.revokeReason === 'user' && ' by you'}
          </span>
        ),
    },
    {
      id: 'used',
      header: 'Last used',
      nowrap: true,
      cell: (view) =>
        view.lastTokenAt ? (
          shortDate(view.lastTokenAt, now)
        ) : (
          <span className={styles.quiet}>never</span>
        ),
    },
    {
      id: 'missions',
      header: 'Missions it prepared',
      cell: (view) => {
        const [first] = view.missions;
        if (!first) return <span className={styles.quiet}>none</span>;
        return (
          <>
            {formatNumber(view.missions.length)}{' '}
            <span className={styles.quiet}>
              · {first.name}
              {view.missions.length > 1 ? '…' : ''}
            </span>
          </>
        );
      },
    },
  ];

  return (
    <>
      <PageHeader
        doc={DOC_PAGES.connectedApps}
        title={SETTINGS_PAGES.connectedApps.title}
        lede={SETTINGS_PAGES.connectedApps.lede}
        primary={
          <ButtonLink href={`#${CONNECT_ANCHOR}`} variant="primary" external>
            {SETTINGS_ACTIONS.connectApp}
          </ButtonLink>
        }
      />

      {(firstParam(params.revoked) ||
        firstParam(params.problem) === 'not-found' ||
        replayed.length > 0) && (
        <div className={styles.notes}>
          {firstParam(params.revoked) && (
            <Callout tone="ok" title="App disconnected" testId="app-disconnected">
              It can no longer act for you. The missions it prepared are yours and stay.
            </Callout>
          )}
          {firstParam(params.problem) === 'not-found' && (
            <Callout tone="warn" title="No such app">
              This app is not among the ones you connected.
            </Callout>
          )}
          {replayed.map((view) =>
            view.toReview.length > 0 ? (
              <Callout
                key={view.delegation.id}
                tone="bad"
                title={`Review ${
                  view.toReview.length === 1
                    ? 'the mission'
                    : `the ${count(view.toReview.length, TERMS.mission)}`
                } ${view.client.name} prepared`}
                testId="app-replayed"
              >
                <p>
                  The gateway disconnected this app because one of its tokens was presented twice:
                  somebody other than the app may have held it, and may have prepared missions in
                  your name. The missions below still run and were <strong>not</strong> stopped.
                  Open each one: stop those you do not recognise, and replace the key of those you
                  keep.
                </p>
                <ul className={styles.list} aria-label="Missions to review">
                  {view.toReview.map((mission) => (
                    <li key={mission.id}>
                      <Link href={`${ROUTES.missions}/${mission.id}`} className={styles.reveal}>
                        {mission.name}
                      </Link>{' '}
                      · {missionWord(mission.status)}
                    </li>
                  ))}
                </ul>
              </Callout>
            ) : (
              <Callout
                key={view.delegation.id}
                tone="warn"
                title={`A token of ${view.client.name} was held by two parties`}
                testId="app-replayed"
              >
                The gateway disconnected this app because one of its tokens was presented twice.
                None of the missions it prepared still runs.
              </Callout>
            ),
          )}
        </div>
      )}

      <Section first>
        {views.length === 0 ? (
          <EmptyState title="You connected no app." testId="no-app">
            An app connects itself, below: it sends you here to sign in and consent.
          </EmptyState>
        ) : (
          <>
            <DataTable
              caption="The apps you connected"
              columns={columns}
              rows={views}
              rowKey={(view) => view.delegation.id}
              rowTone={(view) =>
                view.state === 'revoked' || view.state === 'expired' ? 'quiet' : undefined
              }
              actions={(view) =>
                view.state === 'revoked' ? null : (
                  <ConfirmSubmit
                    action={`${DELEGATIONS_PAGE}/${encodeURIComponent(view.delegation.id)}/revoke`}
                    label={SETTINGS_ACTIONS.revokeApp}
                    ariaLabel={`Disconnect ${view.client.name}`}
                    variant="danger"
                    tone="danger"
                    title={`Disconnect ${view.client.name}?`}
                    consequence="The app loses its access at once and can no longer prepare or manage missions for you. The missions it prepared are yours and keep running."
                    confirmLabel={SETTINGS_ACTIONS.revokeApp}
                    hint="Recorded in the activity, like every change."
                    testId="disconnect-app"
                  />
                )
              }
              rowDetail={(view) =>
                unfolded === view.delegation.id ? (
                  <AppDetail view={view} lifetime={lifetime} />
                ) : null
              }
              testId="connected-apps"
            />
            <Hint>
              A connected app reads your accounts and missions, prepares missions in your name,
              replaces the key of the missions it prepared and can stop any of your missions. It
              never answers a request, touches an account or calls a service. A consent lasts{' '}
              {lifetime} at most.
            </Hint>
          </>
        )}
      </Section>

      <Section
        title={SETTINGS_ACTIONS.connectApp}
        note="Nothing is created here: the app registers itself, then asks you."
        id={CONNECT_ANCHOR}
        testId="connect-app"
      >
        <KeyValue
          items={[
            { term: 'Address', value: <Mono>{door}</Mono> },
            {
              term: 'Claude Code',
              value: (
                <CodeBlock label="Claude Code command">{`claude mcp add --transport http vaubaan-manage ${door}`}</CodeBlock>
              ),
            },
            {
              term: 'Any MCP client',
              value: 'Add an HTTP server at this address; it discovers the sign-in by itself.',
            },
            {
              term: 'Then',
              value: `The app sends you here to sign in and consent, and appears above. It then prepares missions in your name, for ${lifetime} at most; you can disconnect it at any time.`,
            },
          ]}
        />
      </Section>
    </>
  );
}
