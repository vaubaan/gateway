/**
 * `/accounts/new/<provider>` — connect an account of one service. The form is
 * rendered from the plugin's `CredentialSpec`: a button that leads to the
 * service for `oauth2` and `app-install`, the declared fields for `api-key`
 * and `ssh-key`. `?connection=<id>` turns it into "reconnect" for an existing
 * account.
 *
 * A service may connect in two ways (ADR
 * token-connections-beside-the-integration-app): `?method=<kind>` picks one.
 * Without it the page offers the company's app when it is registered — with
 * "Use a token instead" one click away — and the token otherwise, with the
 * guide the plugin declares (`TokenGuide`): where to create it, the
 * permissions to tick, the expiry, what a token cannot run.
 *
 * A field says the shape it expects before the person types (its placeholder
 * and the line under it are the plugin's); the how-to is folded by default.
 * A form the server refused comes back as it was typed — the name and the
 * non-secret values, never a key — with the field in error marked and the
 * shape said again under it (`Notice.form`).
 */
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { NeedsUser } from '@/components/auth/NeedsUser';
import { CredentialFieldInputs, NoticeBanner } from '@/components/connections/parts';
import { TokenGuide } from '@/components/connections/TokenGuide';
import {
  Button,
  ButtonLink,
  Callout,
  Disclosure,
  Field,
  FormStep,
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
import {
  ACCOUNT_ACTIONS,
  ACCOUNT_PAGES,
  ACTIONS,
  PAGES,
  ROUTES,
  TOKEN_CONNECT,
} from '@/lib/vocabulary';
import {
  connectionPath,
  CONNECTIONS_PATH,
  defaultMethod,
  isConnectError,
  methodOf,
  METHOD_FIELD,
  NEW_CONNECTION_PATH,
  PROVIDER_APPS_PAGE,
  type ConnectableProvider,
  type ConnectionDetail,
  type ConnectMethod,
} from '@/server/connections';
import { providerPath } from '@/server/providers/links';

import styles from '../../accounts.module.css';

export const dynamic = 'force-dynamic';

const MAX_NAME_LENGTH = 80;

/** One sentence: how an account of this service is connected this way. */
function ledeOf(provider: ConnectableProvider, method: ConnectMethod): string {
  const name = provider.displayName;
  switch (method.kind) {
    case 'oauth2':
      return `You sign in at ${name} and allow your company’s app; the gateway never sees your password.`;
    case 'app-install':
      return `You install your company’s ${name} app on the account you choose, then come back here.`;
    case 'api-key':
      return method.label
        ? `Create a ${method.label} at ${name} and paste it here.`
        : `${name} has no sign-in flow for this: paste a key you created there.`;
    case 'ssh-key':
      return 'The gateway makes a key pair and keeps the private key; you install the public key on the host.';
  }
}

/** What the folded how-to says, per way of connecting. */
function HowTo({
  provider,
  method,
  reconnect,
}: {
  provider: ConnectableProvider;
  method: ConnectMethod;
  reconnect: boolean;
}) {
  const name = provider.displayName;
  return (
    <div className={styles.prose}>
      {method.kind === 'oauth2' && (
        <p>
          “Continue” sends you to {name}. You sign in there and allow the app your company
          registered; {name} then sends you back here with a credential, which is encrypted and kept
          under your name.
        </p>
      )}
      {method.kind === 'app-install' && (
        <p>
          “Continue” sends you to {name}, where you choose the account and what the app may reach.
          {name} then sends you back here; the gateway checks that the installation is yours before
          it keeps anything.
        </p>
      )}
      {method.kind === 'api-key' && (
        <p>
          Create the key at {name}
          {method.createUrl && (
            <>
              {' '}
              (
              <a href={method.createUrl} target="_blank" rel="noreferrer noopener">
                open its page
              </a>
              )
            </>
          )}
          , give it only what your agents will need, and paste it here. It is checked against {name}
          , then stored encrypted; it is never shown again.
        </p>
      )}
      {method.kind === 'ssh-key' && (
        <p>
          The private key is stored encrypted and never leaves this gateway. The public key is shown
          on the account page: append it to <code>~/.ssh/authorized_keys</code> of the login user on
          the host.{reconnect && ' Reconnecting makes a new pair: install the new public key.'}
        </p>
      )}
    </div>
  );
}

function submitLabel(
  provider: ConnectableProvider,
  method: ConnectMethod,
  reconnect: boolean,
): string {
  if (method.usesApp) return `Continue to ${provider.displayName}`;
  if (reconnect) return ACCOUNT_ACTIONS.reconnect;
  if (method.kind === 'ssh-key') return 'Make the key pair and connect';
  return method.guide ? TOKEN_CONNECT.submit : ACCOUNT_ACTIONS.connect;
}

/** This page with another way chosen; the account and the return path stay. */
function wayPath(
  provider: ConnectableProvider,
  method: ConnectMethod,
  keep: { readonly connection: string | null; readonly returnTo: string | null },
): string {
  const query = new URLSearchParams({ [METHOD_FIELD]: method.kind });
  if (keep.connection) query.set('connection', keep.connection);
  if (keep.returnTo) query.set('return_to', keep.returnTo);
  return `${NEW_CONNECTION_PATH}/${encodeURIComponent(provider.id)}?${query.toString()}`;
}

/**
 * The form alone, or — for a way with a guide — the guide's steps, then the
 * form as the last step ("Paste it here"): the token is created before it is
 * pasted.
 */
function Guided({
  guide,
  step,
  children,
}: {
  guide: React.ReactNode;
  step: number;
  children: React.ReactNode;
}) {
  if (!guide) return <>{children}</>;
  return (
    <div className={styles.guided}>
      {guide}
      <FormStep n={step} title={TOKEN_CONNECT.pasteTitle} testId="token-paste">
        {children}
      </FormStep>
    </div>
  );
}

function unownedOf(reconnect: ConnectionDetail | null): boolean {
  return reconnect?.connection.status === 'unowned';
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
  // A refused form comes back as it was typed (never a secret), its field in error marked.
  const typed = notice?.form;

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
  // The way asked for, else the way the account being reconnected was made, else the one offered.
  const method =
    methodOf(provider, firstParam(query[METHOD_FIELD])) ??
    methodOf(provider, reconnect?.credentialKind) ??
    defaultMethod(provider);
  const redirectFlow = method.usesApp;
  const keep = { connection: reconnect?.connection.id ?? null, returnTo };
  // The other way, offered one click away when it can be used now.
  const other = provider.methods.find((m) => m !== method && m.configured) ?? null;
  const appWay = provider.methods.find((m) => m.usesApp) ?? null;
  const tokenWithoutApp = !method.usesApp && appWay !== null && !appWay.configured;
  // The form is the last step after the guide's one or two.
  const pasteStep =
    method.guide && (method.guide.permissions.length > 0 || method.unavailableTools.length > 0)
      ? 3
      : 2;
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
        lede={ledeOf(provider, method)}
        secondary={
          other && !unownedOf(reconnect)
            ? [
                <ButtonLink
                  key="other-way"
                  href={wayPath(provider, other, keep)}
                  variant="ghost"
                  data-testid="connect-other-way"
                >
                  {other.usesApp ? TOKEN_CONNECT.useApp(name) : TOKEN_CONNECT.useToken}
                </ButtonLink>,
              ]
            : undefined
        }
      />
      <NoticeBanner notice={notice} />

      {unowned ? (
        <Callout tone="warn" title="This account has no owner">
          It cannot be reconnected until an administrator names a new owner. The missions that use
          it keep running meanwhile.
        </Callout>
      ) : !method.configured ? (
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
        <Guided
          guide={
            method.guide ? (
              <>
                {tokenWithoutApp && (
                  <Hint>
                    {TOKEN_CONNECT.appMissing(name)}{' '}
                    {principal.isOperator && TOKEN_CONNECT.appMissingForAdmin}
                  </Hint>
                )}
                <TokenGuide service={name} method={method} />
              </>
            ) : null
          }
          step={pasteStep}
        >
          <form
            method="post"
            action={`${CONNECTIONS_PATH}/connect/${encodeURIComponent(provider.id)}`}
            className={styles.form}
          >
            {returnTo && <input type="hidden" name="return_to" value={returnTo} />}
            <input type="hidden" name={METHOD_FIELD} value={method.kind} />
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
                  defaultValue={typed?.name ?? ''}
                />
              </Field>
            )}
            <CredentialFieldInputs
              idPrefix="credential"
              fields={method.fields}
              values={{ ...reconnect?.fields, ...typed?.values }}
              invalid={typed?.invalid}
            />
            <div className={styles.formActions}>
              <Button type="submit" variant="primary">
                {submitLabel(provider, method, reconnect !== null)}
              </Button>
              <ButtonLink href={back} variant="ghost">
                {ACTIONS.cancel}
              </ButtonLink>
              {!method.guide && (
                <span className={styles.formHint}>
                  {redirectFlow
                    ? `You come back here once ${name} has answered.`
                    : method.kind === 'ssh-key'
                      ? 'The private key is encrypted at rest and never shown.'
                      : TOKEN_CONNECT.submitHint(name)}
                </span>
              )}
            </div>
            {method.guide ? (
              <div className={styles.prose}>
                <p>{TOKEN_CONNECT.whatWeDo(name)}</p>
                <p>{TOKEN_CONNECT.sharedAccount}</p>
              </div>
            ) : (
              <Disclosure
                id={`account-connect:${method.kind}`}
                show={redirectFlow ? `What happens at ${name}` : 'How to get what this form asks'}
                hide="Hide the how-to"
                testId="connect-how-to"
              >
                <HowTo provider={provider} method={method} reconnect={reconnect !== null} />
              </Disclosure>
            )}
          </form>
        </Guided>
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
