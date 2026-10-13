/**
 * `/accounts/new/<provider>` — the connect form of one provider, rendered
 * from its plugin's `CredentialSpec`: a redirect button for `oauth2` and
 * `app-install`, the declared fields for `api-key` and `ssh-key`.
 * `?connection=<id>` turns it into "reconnect" for an existing connection.
 */
import Link from 'next/link';
import { PAGES } from '@/lib/vocabulary';
import { notFound } from 'next/navigation';

import { NeedsUser } from '@/components/auth/NeedsUser';
import styles from '@/components/connections/connections.module.css';
import {
  CredentialFieldInputs,
  credentialKindLabel,
  ExperimentalBadge,
  NoticeBanner,
} from '@/components/connections/parts';
import {
  Banner,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Field,
  Input,
  Stack,
} from '@/components/ui';
import { providerPath } from '@/server/providers/links';
import {
  currentActor,
  firstParam,
  takeNotice,
  type PageSearchParams,
} from '@/lib/connections/session';
import {
  isConnectError,
  CONNECTIONS_PATH,
  NEW_CONNECTION_PATH,
  type ConnectionDetail,
} from '@/server/connections';

export const dynamic = 'force-dynamic';

const MAX_NAME_LENGTH = 80;

export default async function ConnectOneProviderPage({
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
  // The server refuses to reconnect an unowned connection (`connection-unowned`).
  const unowned = reconnect?.connection.status === 'unowned';

  return (
    <Stack gap="var(--space-6)">
      <div>
        <p className={styles.muted}>
          <Link href={CONNECTIONS_PATH}>{PAGES.accounts.title}</Link> /{' '}
          <Link href={NEW_CONNECTION_PATH}>Connect a provider</Link> / {provider.displayName}
        </p>
        <h1 className={styles.badges}>
          {reconnect ? `Reconnect ${reconnect.connection.displayName}` : provider.displayName}
          {provider.experimental && <ExperimentalBadge />}
        </h1>
        {provider.description && <p className={styles.muted}>{provider.description}</p>}
        <p className={styles.muted}>
          <Link href={providerPath(provider.id)} className={styles.refLink}>
            What a mission can do with {provider.displayName}: data model, risks, presets
          </Link>
        </p>
      </div>

      <NoticeBanner notice={notice} />

      {provider.experimental && (
        <Banner tone="warning" title="Experimental provider">
          This plugin can be connected, but it is hidden from mission issuance by default and may
          expose no tool yet.
        </Banner>
      )}

      {unowned ? (
        <Banner tone="warning" title="No owner">
          This connection cannot be reconnected: an operator must reassign an owner first.
        </Banner>
      ) : !provider.configured ? (
        <Banner tone="warning" title="Not available yet">
          An operator must register the company app for {provider.displayName} first (Administration
          → Provider apps).
        </Banner>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>{credentialKindLabel(provider.kind)}</CardTitle>
          </CardHeader>
          <CardBody>
            <form
              method="post"
              action={`${CONNECTIONS_PATH}/connect/${encodeURIComponent(provider.id)}`}
            >
              {returnTo && <input type="hidden" name="return_to" value={returnTo} />}
              {reconnect && (
                <input type="hidden" name="connection_id" value={reconnect.connection.id} />
              )}
              <Stack gap="var(--space-4)">
                {!reconnect && (
                  <Field
                    label="Connection name (optional)"
                    htmlFor="connection-name"
                    hint="How it appears in your list — useful with two accounts of the same provider."
                  >
                    <Input
                      id="connection-name"
                      name="name"
                      maxLength={MAX_NAME_LENGTH}
                      placeholder={provider.displayName}
                      autoComplete="off"
                    />
                  </Field>
                )}

                {provider.kind === 'oauth2' && (
                  <p className={styles.muted}>
                    You will be sent to {provider.displayName} to authorize the app your company
                    registered, then brought back here. The gateway never sees your password.
                  </p>
                )}
                {provider.kind === 'app-install' && (
                  <p className={styles.muted}>
                    You will be sent to {provider.displayName} to install the app your company
                    registered on the account you choose, then brought back here.
                  </p>
                )}
                {provider.kind === 'api-key' && (
                  <p className={styles.muted}>
                    Paste a key you created at {provider.displayName}
                    {provider.createUrl && (
                      <>
                        {' '}
                        (
                        <a href={provider.createUrl} target="_blank" rel="noreferrer noopener">
                          create one
                        </a>
                        )
                      </>
                    )}
                    . It is checked against the provider, then stored encrypted; it is never shown
                    again.
                  </p>
                )}
                {provider.kind === 'ssh-key' && (
                  <p className={styles.muted}>
                    The instance generates an ed25519 key pair. The private key is stored encrypted
                    and never leaves the instance; the public key is shown on the next page for you
                    to install on the host.
                    {reconnect && ' Reconnecting generates a new pair: install the new public key.'}
                  </p>
                )}

                <CredentialFieldInputs
                  idPrefix="credential"
                  fields={provider.fields}
                  values={reconnect?.fields}
                />

                <div className={styles.actions}>
                  <Button type="submit" variant="primary">
                    {redirectFlow
                      ? `Continue to ${provider.displayName}`
                      : reconnect
                        ? 'Reconnect'
                        : provider.kind === 'ssh-key'
                          ? 'Generate key and connect'
                          : 'Connect'}
                  </Button>
                  <Link
                    href={
                      reconnect
                        ? `${CONNECTIONS_PATH}/${reconnect.connection.id}`
                        : NEW_CONNECTION_PATH
                    }
                  >
                    Cancel
                  </Link>
                </div>
              </Stack>
            </form>
          </CardBody>
        </Card>
      )}
    </Stack>
  );
}
