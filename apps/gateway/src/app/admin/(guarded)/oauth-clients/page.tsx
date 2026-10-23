/**
 * `/admin/oauth-clients` — Registered apps: the apps that may ask people to
 * connect them (spec §4.1 bis): every registered OAuth client, what the
 * registration policy says of it, and the administrator's decision.
 * Approving lets an app reach a consent screen; disabling bars it and
 * disconnects it from everyone, which is asked first.
 *
 * `?app=<id>` unfolds the facts of one: the id it registered under, where it
 * sends access, how it registered.
 */
import Link from 'next/link';

import { LocalDate } from '@/components/LocalDate';
import styles from '@/components/settings/settings.module.css';
import {
  Button,
  Callout,
  ConfirmSubmit,
  DataTable,
  EmptyState,
  Hint,
  KeyValue,
  Mono,
  PageHeader,
  Section,
  StatusMark,
  Tag,
  type Column,
} from '@/components/ui';
import { requireOperator } from '@/lib/auth/session';
import { firstParam, type PageSearchParams } from '@/lib/connections/session';
import {
  CONFIG_WORDS,
  REGISTERED_APP_STATES,
  SETTINGS_ACTIONS,
  SETTINGS_PAGES,
  shortDate,
} from '@/lib/vocabulary';
import { OAUTH_CLIENTS_PAGE, redirectDestination, type ClientView } from '@/server/oauth-as';

export const dynamic = 'force-dynamic';

/** The query parameter that unfolds the facts of one app. */
const APP_PARAM = 'app';

const POLICY: Readonly<Record<string, string>> = {
  open: 'Any app that registers may ask people to connect it at once.',
  'operator-approved': 'An app waits for your approval before it can ask anyone.',
  closed: 'No app registers; only the ones you approved are usable.',
};

function AppFacts({ view }: { view: ClientView }) {
  const { client } = view;
  return (
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
          term: 'Registered',
          value: (
            <>
              <LocalDate ts={client.createdAt} />{' '}
              {client.registration === 'metadata-document'
                ? 'from its metadata document'
                : 'by registering itself'}
              {client.tokenEndpointAuthMethod === 'none'
                ? ', without a secret (a public client)'
                : ', with a secret (a confidential client)'}
            </>
          ),
        },
        {
          term: 'Sends access to',
          value: (
            <span className={styles.namedText}>
              {client.redirectUris.map((uri) => {
                const destination = redirectDestination(uri);
                return (
                  <span key={uri} className={styles.inline}>
                    <Mono>{uri}</Mono>
                    {destination?.kind === 'web' && <Tag tone="warn">a server</Tag>}
                    {destination?.kind === 'app-scheme' && <Tag>an app link</Tag>}
                  </span>
                );
              })}
            </span>
          ),
        },
        ...(client.clientUri
          ? [{ term: 'Home page', value: <Mono>{client.clientUri}</Mono> }]
          : []),
        {
          term: 'Decided',
          value: (
            <>
              {view.decidedBy === 'operator' ? 'by an administrator' : 'by the policy'}
              {client.decidedAt && (
                <>
                  {' '}
                  · <LocalDate ts={client.decidedAt} />
                </>
              )}
            </>
          ),
        },
      ]}
    />
  );
}

export default async function RegisteredAppsPage({
  searchParams,
}: {
  searchParams: PageSearchParams;
}) {
  const { root } = await requireOperator();
  const params = await searchParams;
  const views = await root.oauth.clients.list();
  const registration = root.config.oauth.clientRegistration;
  const door = root.oauth.endpoints.resource;
  const decided = firstParam(params.decided);
  const unfolded = firstParam(params[APP_PARAM]);
  const now = new Date();

  const columns: readonly Column<ClientView>[] = [
    {
      id: 'app',
      header: 'App',
      cell: (view) => {
        const open = unfolded === view.client.id;
        const query = open ? '' : `?${APP_PARAM}=${encodeURIComponent(view.client.id)}`;
        return (
          <span className={styles.namedText} id={view.client.id}>
            <Link
              href={`${OAUTH_CLIENTS_PAGE}${query}`}
              scroll={false}
              aria-expanded={open}
              className={styles.name}
              data-testid={`registered-app-${view.client.id}`}
            >
              {view.client.name}
            </Link>
            <span className={styles.sub}>
              registered {shortDate(view.client.createdAt, now)}
              {view.loopbackOnly && ' · sends access to this computer only'}
            </span>
          </span>
        );
      },
    },
    {
      id: 'state',
      header: 'State',
      nowrap: true,
      cell: (view) => {
        const state = REGISTERED_APP_STATES[view.status];
        return state.tone ? (
          <StatusMark tone={state.tone}>{state.label}</StatusMark>
        ) : (
          <span className={view.status === 'disabled' ? styles.quiet : undefined}>
            {state.label}
          </span>
        );
      },
    },
    {
      id: 'decided',
      header: 'Decided by',
      nowrap: true,
      cell: (view) => (
        <span className={styles.quiet}>
          {view.decidedBy === 'operator' ? 'an administrator' : 'the policy'}
        </span>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title={SETTINGS_PAGES.registeredApps.title}
        lede={SETTINGS_PAGES.registeredApps.lede}
      />

      {(decided === 'approved' ||
        decided === 'disabled' ||
        firstParam(params.problem) === 'not-found') && (
        <div className={styles.notes}>
          {decided === 'approved' && (
            <Callout tone="ok" title="App approved" testId="app-approved">
              It can now ask people to connect it.
            </Callout>
          )}
          {decided === 'disabled' && (
            <Callout tone="ok" title="App disabled" testId="app-disabled">
              It was disconnected from everyone who had connected it; each disconnection is in the
              activity.
            </Callout>
          )}
          {firstParam(params.problem) === 'not-found' && (
            <Callout tone="warn" title="No such app">
              This app is not registered on this gateway.
            </Callout>
          )}
        </div>
      )}

      <Section first>
        {views.length === 0 ? (
          <EmptyState title="No app has registered yet." testId="no-registered-app" />
        ) : (
          <DataTable
            caption="The apps registered on this gateway"
            columns={columns}
            rows={views}
            rowKey={(view) => view.client.id}
            rowTone={(view) => (view.status === 'disabled' ? 'quiet' : undefined)}
            actions={(view) => {
              const action = `${OAUTH_CLIENTS_PAGE}/${encodeURIComponent(view.client.id)}`;
              return (
                <>
                  {view.status !== 'approved' && (
                    <form method="post" action={action} className={styles.inlineForm}>
                      <Button
                        type="submit"
                        name="action"
                        value="approve"
                        variant={view.status === 'pending' ? 'primary' : 'secondary'}
                        size="sm"
                        aria-label={`Approve ${view.client.name}`}
                      >
                        {SETTINGS_ACTIONS.approve}
                      </Button>
                    </form>
                  )}{' '}
                  {view.status !== 'disabled' && (
                    <ConfirmSubmit
                      action={action}
                      fields={{ action: 'disable' }}
                      label={SETTINGS_ACTIONS.disable}
                      ariaLabel={`Disable ${view.client.name}`}
                      variant="danger"
                      tone="danger"
                      title={`Disable ${view.client.name}?`}
                      consequence="Nobody can connect this app any more, and everyone who had connected it loses it at once. The missions it prepared are theirs and keep running."
                      confirmLabel="Disable the app"
                      hint="You can approve it again later; people then connect it anew."
                      testId="disable-app"
                    />
                  )}
                </>
              );
            }}
            rowDetail={(view) => (unfolded === view.client.id ? <AppFacts view={view} /> : null)}
            testId="registered-apps"
          />
        )}
        <Hint>
          An app registers itself the first time somebody points an MCP client at{' '}
          <Mono>{door}</Mono>; there is nothing to create here.{' '}
          {POLICY[registration.policy] ?? registration.policy}
          {registration.policy === 'operator-approved' &&
            (registration.autoApproveLoopback
              ? ' An app that can only send access back to the person’s own computer needs no approval.'
              : ' Every app, without exception.')}{' '}
          {CONFIG_WORDS.fileReadOnly} (<Mono>oauth.client_registration</Mono>)
        </Hint>
      </Section>
    </>
  );
}
