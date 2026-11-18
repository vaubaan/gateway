/**
 * `/accounts/new/<service>` — connect an account of one service: the one
 * place to authorize it (ADR one-place-to-authorize-services-token-first).
 * The form is rendered from the plugin's `CredentialSpec`: the guide and the
 * declared fields for `api-key` (`TokenGuide`: how wide to grant and why, the
 * steps, the token page, the permissions to tick, the expiry, the service's
 * documentation), a button that leads to the service for
 * `oauth2`, the fields for `ssh-key`. `?account=<id>` turns it into
 * "reconnect" for an existing account.
 *
 * A service that signs people in (`oauth2`, Miro) needs nothing declared:
 * the gateway registers its own client there, and the button leads straight
 * to the service (ADRs oauth-client-registered-by-the-gateway,
 * gmail-over-imap-with-an-app-password).
 *
 * A key that comes in several shapes (`CredentialAlternative`: a Vercel token
 * for a team or for one project) starts its guide with a radio; the steps and
 * fields of the alternatives not chosen are hidden by the page's CSS, and the
 * server reads only the chosen one's.
 *
 * A field says the shape it expects before the person types (its placeholder
 * and the line under it are the plugin's); the how-to is open by default.
 * A form the server refused comes back as it was typed — the name and the
 * non-secret values, never a key — with the field in error marked and the
 * shape said again under it (`Notice.form`).
 */
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { NeedsUser } from '@/components/auth/NeedsUser';
import { CredentialFieldInputs, NoticeBanner } from '@/components/accounts/parts';
import { TokenGuide } from '@/components/accounts/TokenGuide';
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
} from '@/lib/accounts/session';
import {
  connectHint,
  serviceDoc,
  ACCOUNT_ACTIONS,
  ACCOUNT_PAGES,
  ACTIONS,
  PAGES,
  ROUTES,
  TOKEN_CONNECT,
} from '@/lib/vocabulary';
import {
  chooseAlternative,
  accountPath,
  ACCOUNTS_PATH,
  isConnectError,
  NEW_ACCOUNT_PATH,
  type ConnectableService,
  type AccountDetail,
} from '@/server/accounts';
import { servicePath } from '@/lib/services/links';

import styles from '../../accounts.module.css';
import { DETAIL_PARAM, INSTALL_PROBLEM_PARAM } from '@/server/plugins/handlers';
import { InstallFirst } from './install-first';

export const dynamic = 'force-dynamic';

const MAX_NAME_LENGTH = 80;
/** The connect form; the radio between a key's alternatives sits in the guide and names it. */
const CONNECT_FORM_ID = 'connect-form';

/** One sentence: how an account of this service is connected. */
function ledeOf(service: ConnectableService): string {
  const name = service.displayName;
  switch (service.kind) {
    case 'oauth2':
      return `You sign in at ${name} and allow this gateway; there is nothing to create or paste, and the gateway never sees your password.`;
    case 'api-key':
      return service.label
        ? `Create a ${service.label} at ${name} and paste it here.`
        : `${name} has no sign-in flow for this: paste a key you created there.`;
    case 'ssh-key':
      return 'The gateway makes a key pair and keeps the private key; you install the public key on the host.';
    case 'host':
      return `Your own place on this gateway: one click, nothing to create or paste. A mission on it lets an agent prepare missions in your name, within what you hold; the account is yours alone and is never shared.`;
  }
}

/**
 * What the how-to says for a way without a token guide (`oauth2`, `ssh-key`);
 * a token way shows its guide instead.
 */
function HowTo({ service, reconnect }: { service: ConnectableService; reconnect: boolean }) {
  const name = service.displayName;
  return (
    <div className={styles.prose}>
      {service.kind === 'oauth2' && !service.viaBroker && (
        <p>
          “Continue” sends you to {name}. You sign in there and allow this gateway, which registered
          itself as an app at {name} the first time someone connected; {name} then sends you back
          here with a credential, which is encrypted and kept under your name.
        </p>
      )}
      {service.kind === 'oauth2' && service.viaBroker && (
        <p>
          “Continue” sends you to {name}. You sign in there and allow the app of the OAuth broker
          this gateway is enrolled with; the broker sends you back here with the authorization,
          which is encrypted and kept under your name. The broker keeps none of it and only renews
          the access when this gateway asks; your {name} data never goes through it.
        </p>
      )}
      {service.kind === 'oauth2' && service.viaBroker && service.brokerAttested === false && (
        <p>
          This gateway’s OAuth broker is <strong>not attested</strong>: an administrator declared it
          with <code>attestation: none</code>, so the gateway does not check which code the broker
          runs before it sends it your authorization.
        </p>
      )}
      {service.kind === 'ssh-key' && (
        <p>
          The private key is stored encrypted and never leaves this gateway. The public key is shown
          on the account page: append it to <code>~/.ssh/authorized_keys</code> of the login user on
          the host.{reconnect && ' Reconnecting makes a new pair: install the new public key.'}
        </p>
      )}
    </div>
  );
}

function submitLabel(service: ConnectableService, reconnect: boolean): string {
  if (service.redirects) return `Continue to ${service.displayName}`;
  if (reconnect) return ACCOUNT_ACTIONS.reconnect;
  if (service.kind === 'ssh-key') return 'Make the key pair and connect';
  return service.guide ? TOKEN_CONNECT.submit : ACCOUNT_ACTIONS.connect;
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

export default async function ConnectOneAccountPage({
  params,
  searchParams,
}: {
  params: Promise<{ service: string }>;
  searchParams: PageSearchParams;
}) {
  const session = await currentActor();
  if (!session) return <NeedsUser />;
  const { root, principal, actor } = session;
  const { service: serviceId } = await params;
  const query = await searchParams;
  const accounts = root.accounts.service;
  const service = await accounts.service(serviceId);
  if (!service) {
    // No plugin yet: the catalog's, installed when first needed (ADR
    // plugins-installed-when-first-needed).
    const offered = root.updates.current()?.pluginsAvailable.find((p) => p.id === serviceId);
    if (!offered) notFound();
    return (
      <InstallFirst
        serviceId={serviceId}
        version={offered.released}
        problem={firstParam(query[INSTALL_PROBLEM_PARAM])}
        detail={firstParam(query[DETAIL_PARAM])}
      />
    );
  }
  const notice = await takeNotice(root, principal.sessionId, query);
  // A refused form comes back as it was typed (never a secret), its field in error marked.
  const typed = notice?.form;

  const reconnectId = firstParam(query.account);
  let reconnect: AccountDetail | null = null;
  if (reconnectId) {
    try {
      reconnect = await accounts.get(actor, reconnectId);
    } catch (err) {
      if (isConnectError(err)) notFound();
      throw err;
    }
    if (reconnect.account.service !== service.id) notFound();
  }
  const returnTo = firstParam(query.return_to);
  const redirectFlow = service.redirects;
  // The form is the last step after the guide's one or two.
  const pasteStep = service.guide && service.guide.permissions.length > 0 ? 3 : 2;
  // The server refuses to reconnect an account without owner (`account-unowned`).
  const unowned = reconnect?.account.status === 'unowned';
  const name = service.displayName;
  const back = reconnect ? accountPath(reconnect.account.id) : ROUTES.accounts;
  const values = { ...reconnect?.fields, ...typed?.values };
  // The alternative checked: the one the refused form was read with, or the
  // one the account's fields belong to; the first one otherwise.
  const choice = chooseAlternative(service, values, typed?.alternative);
  const chosen = choice.ok ? (choice.alternative?.id ?? null) : null;

  return (
    <>
      <PageHeader
        width="narrow"
        crumbs={
          reconnect
            ? [
                { label: PAGES.accounts.title, href: ROUTES.accounts },
                { label: reconnect.account.displayName, href: back },
                { label: ACCOUNT_ACTIONS.reconnect },
              ]
            : [
                { label: PAGES.accounts.title, href: ROUTES.accounts },
                { label: ACCOUNT_PAGES.connect.title, href: NEW_ACCOUNT_PATH },
                { label: name },
              ]
        }
        mark={<ServiceMark name={name} icon={service.icon} size="lg" />}
        title={
          reconnect
            ? `Reconnect ${reconnect.account.displayName}`
            : `Connect ${/^[aeiou]/i.test(name) ? 'an' : 'a'} ${name} account`
        }
        lede={ledeOf(service)}
        doc={serviceDoc(
          service.id,
          name,
          'connect',
          connectHint(name, service.kind, service.label),
        )}
      />
      <NoticeBanner notice={notice} />

      {unowned ? (
        <Callout tone="warn" title="This account has no owner">
          It cannot be reconnected until an administrator names a new owner. The missions that use
          it keep running meanwhile.
        </Callout>
      ) : service.unavailable !== null ? (
        <Callout tone="warn" title="Not configured on this gateway">
          {service.unavailable}
        </Callout>
      ) : (
        <Guided
          guide={
            service.guide ? (
              <TokenGuide
                serviceName={name}
                service={service}
                chosen={chosen}
                formId={CONNECT_FORM_ID}
              />
            ) : null
          }
          step={pasteStep}
        >
          <form
            id={CONNECT_FORM_ID}
            method="post"
            action={`${ACCOUNTS_PATH}/connect/${encodeURIComponent(service.id)}`}
            className={styles.form}
          >
            {returnTo && <input type="hidden" name="return_to" value={returnTo} />}
            {reconnect && <input type="hidden" name="account_id" value={reconnect.account.id} />}
            {/* A host account is the person's own place on the gateway: one, named after the service. */}
            {!reconnect && service.kind !== 'host' && (
              <Field
                label="Name"
                shape="how it appears in missions"
                optional
                htmlFor="account-name"
                hint={`Useful with two ${name} accounts.`}
              >
                <Input
                  id="account-name"
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
              fields={service.fields}
              alternatives={service.alternatives}
              values={values}
              invalid={typed?.invalid}
            />
            <div className={styles.formActions}>
              <Button type="submit" variant="primary">
                {submitLabel(service, reconnect !== null)}
              </Button>
              <ButtonLink href={back} variant="ghost">
                {ACTIONS.cancel}
              </ButtonLink>
              {!service.guide && (
                <span className={styles.formHint}>
                  {redirectFlow
                    ? `You come back here once ${name} has answered.`
                    : service.kind === 'host'
                      ? 'Nothing to paste: the account holds no secret.'
                      : service.kind === 'ssh-key'
                        ? 'The private key is encrypted at rest and never shown.'
                        : TOKEN_CONNECT.submitHint(name)}
                </span>
              )}
            </div>
            {service.guide ? (
              <div className={styles.prose}>
                <p>{TOKEN_CONNECT.whatWeDo(name)}</p>
                <p>{TOKEN_CONNECT.sharedAccount}</p>
              </div>
            ) : service.kind === 'host' ? null : (
              <Disclosure
                id={`account-connect:${service.kind}`}
                defaultOpen
                show={redirectFlow ? `What happens at ${name}` : 'How to get what this form asks'}
                hide="Hide the how-to"
                testId="connect-how-to"
              >
                <HowTo service={service} reconnect={reconnect !== null} />
              </Disclosure>
            )}
          </form>
        </Guided>
      )}

      {!reconnect && service.kind === 'host' && (
        <Section title="After connecting">
          <Hint>
            The account is yours alone: it cannot be given to a colleague or a team. Create a
            mission on it — the gateway offers the platform management mission, every macro-action
            at Careful — and hand its key to the agent that prepares your missions. What that agent
            can do, permission by permission, is in the{' '}
            <Link href={servicePath(service.id)}>{name} reference</Link>.
          </Hint>
        </Section>
      )}

      {!reconnect && service.kind !== 'host' && (
        <Section title="After connecting">
          <Hint>
            You own it. Give access to a colleague from the account page; a mission can use it right
            away. What an agent can do on {name}, permission by permission, is in the{' '}
            <Link href={servicePath(service.id)}>{name} reference</Link>.
          </Hint>
        </Section>
      )}
    </>
  );
}
