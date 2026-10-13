/**
 * `/accounts/new/<provider>` — connect an account of one service. The form is
 * rendered from the plugin's `CredentialSpec`: a button that leads to the
 * service for `oauth2` and `app-install`, the declared fields for `api-key`
 * and `ssh-key`. `?connection=<id>` turns it into "reconnect" for an existing
 * account.
 *
 * A field says the shape it expects before the person types (its placeholder
 * and the line under it are the plugin's); the how-to is folded by default.
 */
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { NeedsUser } from '@/components/auth/NeedsUser';
import { CredentialFieldInputs, NoticeBanner } from '@/components/connections/parts';
import {
  Button,
  ButtonLink,
  Callout,
  Disclosure,
  Field,
  Hint,
  Input,
  PageHeader,
  Section,
  ServiceMark,
} from '@/components/ui';
import {
  currentActor,
  firstParam,
  takeNotice,
  type PageSearchParams,
} from '@/lib/connections/session';
import { ACCOUNT_ACTIONS, ACCOUNT_PAGES, ACTIONS, PAGES, ROUTES } from '@/lib/vocabulary';
import {
  connectionPath,
  CONNECTIONS_PATH,
  isConnectError,
  NEW_CONNECTION_PATH,
  PROVIDER_APPS_PAGE,
  type ConnectableProvider,
  type ConnectionDetail,
} from '@/server/connections';
import { providerPath } from '@/server/providers/links';

import styles from '../../accounts.module.css';

export const dynamic = 'force-dynamic';

const MAX_NAME_LENGTH = 80;

/** One sentence: how an account of this service is connected. */
function ledeOf(provider: ConnectableProvider): string {
  const name = provider.displayName;
  switch (provider.kind) {
    case 'oauth2':
      return `You sign in at ${name} and allow your company’s app; the gateway never sees your password.`;
    case 'app-install':
      return `You install your company’s ${name} app on the account you choose, then come back here.`;
    case 'api-key':
      return `${name} has no sign-in flow for this: paste a key you created there.`;
    case 'ssh-key':
      return 'The gateway makes a key pair and keeps the private key; you install the public key on the host.';
  }
}

/** What the folded how-to says, per way of connecting. */
function HowTo({ provider, reconnect }: { provider: ConnectableProvider; reconnect: boolean }) {
  const name = provider.displayName;
  return (
    <div className={styles.prose}>
      {provider.kind === 'oauth2' && (
        <p>
          “Continue” sends you to {name}. You sign in there and allow the app your company
          registered; {name} then sends you back here with a credential, which is encrypted and kept
          under your name.
        </p>
      )}
      {provider.kind === 'app-install' && (
        <p>
          “Continue” sends you to {name}, where you choose the account and what the app may reach.
          {name} then sends you back here; the gateway checks that the installation is yours before
          it keeps anything.
        </p>
      )}
      {provider.kind === 'api-key' && (
        <p>
          Create the key at {name}
          {provider.createUrl && (
            <>
              {' '}
              (
              <a href={provider.createUrl} target="_blank" rel="noreferrer noopener">
                open its page
              </a>
              )
            </>
          )}
          , give it only what your agents will need, and paste it here. It is checked against {name}
          , then stored encrypted; it is never shown again.
        </p>
      )}
      {provider.kind === 'ssh-key' && (
        <p>
          The private key is stored encrypted and never leaves this gateway. The public key is shown
          on the account page: append it to <code>~/.ssh/authorized_keys</code> of the login user on
          the host.{reconnect && ' Reconnecting makes a new pair: install the new public key.'}
        </p>
      )}
    </div>
  );
}

function submitLabel(provider: ConnectableProvider, reconnect: boolean): string {
  if (provider.kind === 'oauth2' || provider.kind === 'app-install') {
    return `Continue to ${provider.displayName}`;
  }
  if (reconnect) return ACCOUNT_ACTIONS.reconnect;
  return provider.kind === 'ssh-key' ? 'Make the key pair and connect' : ACCOUNT_ACTIONS.connect;
}

export default async function ConnectOneAccountPage({
  params,
  searchParams,
}: {
  params: Promise<{ provider: string }>;
  searchParams: PageSearchParams;
}) {
  const session = await currentActor();
  if (!session) return <NeedsUser />;
  const { root, principal, actor } = session;
  const { provider: providerId } = await params;
  const query = await searchParams;
  const service = root.connections.service;
  const provider = await service.provider(providerId);
  if (!provider) notFound();
  const notice = await takeNotice(root, principal.sessionId, query);

  const reconnectId = firstParam(query.connection);
  let reconnect: ConnectionDetail | null = null;
  if (reconnectId) {
    try {
      reconnect = await service.get(actor, reconnectId);
    } catch (err) {
      if (isConnectError(err)) notFound();
      throw err;
    }
    if (reconnect.connection.provider !== provider.id) notFound();
  }
  const returnTo = firstParam(query.return_to);
  const redirectFlow = provider.kind === 'oauth2' || provider.kind === 'app-install';
  // The server refuses to reconnect an account without owner (`connection-unowned`).
  const unowned = reconnect?.connection.status === 'unowned';
  const name = provider.displayName;
  const back = reconnect ? connectionPath(reconnect.connection.id) : ROUTES.accounts;

  return (
    <>
      <PageHeader
        width="narrow"
        crumbs={
          reconnect
            ? [
                { label: PAGES.accounts.title, href: ROUTES.accounts },
                { label: reconnect.connection.displayName, href: back },
                { label: ACCOUNT_ACTIONS.reconnect },
              ]
            : [
                { label: PAGES.accounts.title, href: ROUTES.accounts },
                { label: ACCOUNT_PAGES.connect.title, href: NEW_CONNECTION_PATH },
                { label: name },
              ]
        }
        mark={<ServiceMark name={name} size="lg" />}
        title={
          reconnect
            ? `Reconnect ${reconnect.connection.displayName}`
            : `Connect ${/^[aeiou]/i.test(name) ? 'an' : 'a'} ${name} account`
        }
        lede={ledeOf(provider)}
      />
      <NoticeBanner notice={notice} />

      {unowned ? (
        <Callout tone="warn" title="This account has no owner">
          It cannot be reconnected until an administrator names a new owner. The missions that use
          it keep running meanwhile.
        </Callout>
      ) : !provider.configured ? (
        <Callout
          tone="warn"
          title={`${name} needs a company app first`}
          action={
            principal.isOperator ? (
              <ButtonLink href={PROVIDER_APPS_PAGE} size="sm">
                Register it
              </ButtonLink>
            ) : undefined
          }
        >
          An administrator registers it once, under Settings → Company apps; everyone can then
          connect their {name} accounts.
        </Callout>
      ) : (
        <form
          method="post"
          action={`${CONNECTIONS_PATH}/connect/${encodeURIComponent(provider.id)}`}
          className={styles.form}
        >
          {returnTo && <input type="hidden" name="return_to" value={returnTo} />}
          {reconnect && (
            <input type="hidden" name="connection_id" value={reconnect.connection.id} />
          )}
          {provider.experimental && (
            <Callout tone="neutral" title="Experimental service">
              It can be connected, but it is left out of new missions by default and may offer no
              tool yet.
            </Callout>
          )}
          {!reconnect && (
            <Field
              label="Name"
              shape="how it appears in missions"
              optional
              htmlFor="connection-name"
              hint={`Useful with two ${name} accounts.`}
            >
              <Input
                id="connection-name"
                name="name"
                maxLength={MAX_NAME_LENGTH}
                placeholder={name}
                autoComplete="off"
              />
            </Field>
          )}
          <CredentialFieldInputs
            idPrefix="credential"
            fields={provider.fields}
            values={reconnect?.fields}
          />
          <div className={styles.formActions}>
            <Button type="submit" variant="primary">
              {submitLabel(provider, reconnect !== null)}
            </Button>
            <ButtonLink href={back} variant="ghost">
              {ACTIONS.cancel}
            </ButtonLink>
            <span className={styles.formHint}>
              {redirectFlow
                ? `You come back here once ${name} has answered.`
                : provider.kind === 'ssh-key'
                  ? 'The private key is encrypted at rest and never shown.'
                  : `Checked against ${name} before saving, encrypted at rest.`}
            </span>
          </div>
          <Disclosure
            id={`account-connect:${provider.kind}`}
            show={redirectFlow ? `What happens at ${name}` : 'How to get what this form asks'}
            hide="Hide the how-to"
            testId="connect-how-to"
          >
            <HowTo provider={provider} reconnect={reconnect !== null} />
          </Disclosure>
        </form>
      )}

      {!reconnect && (
        <Section title="After connecting">
          <Hint>
            You own it. Give access to a colleague from the account page; a mission can use it right
            away. What an agent can do on {name}, permission by permission, is in the{' '}
            <Link href={providerPath(provider.id)}>{name} reference</Link>.
          </Hint>
        </Section>
      )}
    </>
  );
}
