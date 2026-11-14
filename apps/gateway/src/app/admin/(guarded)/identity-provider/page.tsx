/**
 * `/admin/identity-provider` — Settings → Sign-in: the sign-in providers of the
 * gateway (spec §4.2; docs/handbook/authentication.md). One row
 * each: its name and id, its kind, who it admits, how many people signed in
 * through it, whether it is on. A provider saved here is edited
 * (`/admin/identity-provider/<id>`), tested beside the session — in another window,
 * signing nobody in, the result on `/admin/identity-provider/<id>/test` (ADR
 * administrators-live-in-the-instance) —, switched on after a passed test, switched
 * off and removed (asked first, with the people it concerns; never the last
 * administrator's way in); one set by the mounted configuration is shown read-only
 * and always on. "Add a sign-in provider" opens the form.
 */
import styles from '@/components/settings/settings.module.css';
import {
  Button,
  ButtonLink,
  Callout,
  ConfirmSubmit,
  DataTable,
  EmptyState,
  Hint,
  Mono,
  PageHeader,
  Section,
  Tag,
  type Column,
} from '@/components/ui';
import { requireOperator } from '@/lib/auth/session';
import { DOC_PAGES, CONFIG_WORDS, SETTINGS_ACTIONS, SETTINGS_PAGES } from '@/lib/vocabulary';
import {
  NEW_SIGN_IN_PROVIDER_PAGE,
  signInProviderPage,
  signInTestPage,
  signInTestPath,
  testPassedSinceSaved,
  type ProviderState,
  type SignInProviderView,
  callbackUrl,
  setUpElsewhere,
} from '@/server/auth';
import { isOpenProvider, issuerKey } from '@/server/config';

export const dynamic = 'force-dynamic';

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function first(value: string | string[] | undefined): string | null {
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}

const KIND_WORDS = { oidc: 'OpenID Connect', github: 'GitHub', local: 'Sign-in accounts' } as const;

/** Who a provider admits, in words. */
function admits(provider: SignInProviderView): string {
  if (provider.invitationOnly) return 'invited people only';
  if (provider.allowedEmailDomains.length > 0) {
    return `${provider.allowedEmailDomains.join(', ')}, and invited people`;
  }
  return 'everyone the directory signs in';
}

interface Row {
  readonly provider: SignInProviderView;
  readonly state: ProviderState;
  readonly people: number;
}

export default async function SignInSettingsPage({ searchParams }: Props) {
  const { root } = await requireOperator();
  const params = await searchParams;
  const problems = ([] as string[]).concat(params.problem ?? []);
  const saved = first(params.saved);
  const removed = first(params.removed);
  const removedPeople = Number(first(params.people) ?? '0');
  const enabled = first(params.enabled);
  const disabled = first(params.disabled);
  const providers = await root.auth.providers.views();
  const administrators = await root.auth.administrators.current();
  const users = await root.store.users.list();
  const states = await Promise.all(providers.map((p) => root.auth.providers.state(p.id)));
  const publicUrl = root.config.publicUrl;
  // Providers whose callback is registered for another address (a restore on a new host).
  const elsewhere = providers
    .map((provider) => ({ provider, host: setUpElsewhere(provider, publicUrl) }))
    .filter(
      (entry): entry is { provider: SignInProviderView; host: string } => entry.host !== null,
    );
  const rows: Row[] = providers.map((provider, index) => ({
    provider,
    state: states[index] ?? {
      enabled: true,
      changedAt: null,
      test: null,
      waiver: null,
      registeredFor: null,
    },
    people: users.filter(
      (user) => user.issuer !== null && issuerKey(user.issuer) === issuerKey(provider.issuer),
    ).length,
  }));

  const columns: readonly Column<Row>[] = [
    {
      id: 'provider',
      header: 'Provider',
      cell: ({ provider }) => (
        <span className={styles.namedText}>
          <span>
            <span className={styles.name}>{provider.name}</span> <Mono>{provider.id}</Mono>
          </span>
          <span className={styles.sub}>
            {provider.kind === 'local' ? 'kept by this gateway' : issuerKey(provider.issuer)}
          </span>
        </span>
      ),
    },
    {
      id: 'kind',
      header: 'Kind',
      nowrap: true,
      cell: ({ provider }) => (
        <span className={styles.inline}>
          {KIND_WORDS[provider.kind]}
          {isOpenProvider(provider) && <Tag>open to anyone</Tag>}
        </span>
      ),
    },
    { id: 'admits', header: 'Admits', cell: ({ provider }) => admits(provider) },
    {
      id: 'state',
      header: 'State',
      cell: ({ provider, state }) => (
        <span className={styles.namedText}>
          {provider.enabled ? (
            provider.kind !== 'local' &&
            provider.source === 'store' &&
            !testPassedSinceSaved(state) ? (
              <span className={styles.inline}>
                on <Tag>changed since its last test</Tag>
              </span>
            ) : (
              'on'
            )
          ) : (
            <span className={styles.quiet}>
              off{testPassedSinceSaved(state) ? ': test passed' : ': test it first'}
            </span>
          )}
          {setUpElsewhere(provider, publicUrl) && (
            <span className={styles.sub} data-testid={`elsewhere-${provider.id}`}>
              set up for {setUpElsewhere(provider, publicUrl)}
            </span>
          )}
          {state.waiver && (
            <span className={styles.sub} data-testid={`waiver-${provider.id}`}>
              second factor waived
              {state.waiver === 'amr' ? ' when the provider says it asked one' : ''}, never for
              administrators
            </span>
          )}
        </span>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        doc={DOC_PAGES.signIn}
        title={SETTINGS_PAGES.signIn.title}
        lede={SETTINGS_PAGES.signIn.lede}
        primary={
          <ButtonLink href={`${NEW_SIGN_IN_PROVIDER_PAGE}?kind=oidc`} variant="primary">
            {SETTINGS_ACTIONS.addSignInProvider}
          </ButtonLink>
        }
        secondary={
          rows.some(({ provider }) => provider.kind === 'local')
            ? [
                <ButtonLink key="github" href={`${NEW_SIGN_IN_PROVIDER_PAGE}?kind=github`}>
                  Add GitHub
                </ButtonLink>,
              ]
            : [
                <ButtonLink key="github" href={`${NEW_SIGN_IN_PROVIDER_PAGE}?kind=github`}>
                  Add GitHub
                </ButtonLink>,
                <ButtonLink key="local" href={`${NEW_SIGN_IN_PROVIDER_PAGE}?kind=local`}>
                  Add sign-in accounts
                </ButtonLink>,
              ]
        }
      />

      {(saved || removed || enabled || disabled || problems.length > 0 || elsewhere.length > 0) && (
        <div className={styles.notes}>
          {elsewhere.map(({ provider, host }) => (
            <Callout
              key={provider.id}
              tone="warn"
              title={`${provider.name} was set up for ${host}`}
              testId={`set-up-elsewhere-${provider.id}`}
            >
              Its callback is registered at {provider.name} under that address, so nobody can sign
              in through it here yet. At {provider.name}, register the callback{' '}
              <Mono>{callbackUrl(publicUrl, provider.id).href}</Mono> for this gateway, then test
              the sign-in: a passed test records this address.
            </Callout>
          ))}
          {saved && (
            <Callout tone="ok" title="Saved" testId="idp-saved">
              The client secret is encrypted at rest. A new provider is off until a test passes: use
              “Test”, which opens the provider in another window and signs nobody in, then switch it
              on.
            </Callout>
          )}
          {enabled && (
            <Callout tone="ok" title={`Provider ${enabled} switched on`} testId="idp-enabled">
              The sign-in page offers it from now on.
            </Callout>
          )}
          {disabled && (
            <Callout tone="ok" title={`Provider ${disabled} switched off`} testId="idp-disabled">
              {removedPeople === 0
                ? 'Nobody else had signed in through it.'
                : `${removedPeople} ${removedPeople === 1 ? 'person' : 'people'} signed in through it: their sessions are over until it is on again.`}
            </Callout>
          )}
          {removed && (
            <Callout tone="ok" title={`Provider ${removed} removed`} testId="idp-removed">
              {removedPeople === 0
                ? 'Nobody else had signed in through it.'
                : `${removedPeople} ${removedPeople === 1 ? 'person' : 'people'} signed in through it: their sessions are over and they can no longer sign in. Their missions and connected apps keep running until you deactivate them on People.`}
            </Callout>
          )}
          {problems.length > 0 && (
            <Callout tone="bad" title="Not done" testId="idp-problems">
              <ul className={styles.list}>
                {problems.map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            </Callout>
          )}
        </div>
      )}

      <Section first>
        {rows.length === 0 ? (
          <EmptyState
            title="Nobody can sign in yet: no sign-in provider is set up."
            action={
              <ButtonLink href={`${NEW_SIGN_IN_PROVIDER_PAGE}?kind=oidc`} variant="primary">
                {SETTINGS_ACTIONS.addSignInProvider}
              </ButtonLink>
            }
            testId="no-sign-in-provider"
          >
            Your company’s directory through OpenID Connect (Entra ID, Google Workspace, Okta,
            Keycloak), GitHub for people who sign in with their own account, or sign-in accounts
            kept by this gateway — an email, a password and a second factor — when there is no
            directory.
          </EmptyState>
        ) : (
          <DataTable
            caption="The providers people sign in through"
            columns={columns}
            rows={rows}
            rowKey={({ provider }) => provider.id}
            actions={({ provider, people, state }) => (
              <span className={styles.inline}>
                {provider.kind !== 'local' && (
                  // A form, in another window: the test runs beside this session, and a
                  // link from elsewhere cannot start one (it writes a pending sign-in).
                  <form method="post" action={signInTestPath(provider.id)} target="_blank">
                    <Button
                      type="submit"
                      size="sm"
                      aria-label={`${SETTINGS_ACTIONS.testSignIn} through ${provider.name}`}
                      data-testid={`test-provider-${provider.id}`}
                    >
                      Test
                    </Button>
                  </form>
                )}
                {state.test && (
                  <ButtonLink href={signInTestPage(provider.id)} size="sm" variant="ghost">
                    Last test
                  </ButtonLink>
                )}
                {provider.source === 'store' && !provider.enabled && (
                  <form
                    method="post"
                    action={`/api/admin/sign-in-providers/${encodeURIComponent(provider.id)}/enable`}
                  >
                    <Button
                      type="submit"
                      size="sm"
                      variant="primary"
                      aria-label={`Switch ${provider.name} on`}
                      data-testid={`enable-provider-${provider.id}`}
                    >
                      Switch on
                    </Button>
                  </form>
                )}
                {provider.kind !== 'local' && (
                  // Reversible either way, so asked nowhere (spec §4.2): the button's
                  // title says what it does.
                  <form
                    method="post"
                    action={`/api/admin/sign-in-providers/${encodeURIComponent(provider.id)}/waiver`}
                  >
                    <input
                      type="hidden"
                      name="waiver"
                      value={state.waiver ? 'none' : provider.kind === 'oidc' ? 'amr' : 'always'}
                      readOnly
                    />
                    <Button
                      type="submit"
                      size="sm"
                      variant="ghost"
                      aria-label={`Second factor for ${provider.name}`}
                      title={
                        state.waiver
                          ? 'Each of its people enrols one at their next sign-in.'
                          : provider.kind === 'oidc'
                            ? 'Its people sign in without this gateway’s code when the provider says it asked a second factor of its own (the “mfa” method of its token); otherwise the code is still asked. Never for administrators. Do it only for a directory that enforces one.'
                            : 'Its people sign in without this gateway’s code: you vouch that the provider enforces a second factor of its own. Never for administrators.'
                      }
                      data-testid={`waiver-toggle-${provider.id}`}
                    >
                      {state.waiver ? 'Ask the second factor again' : 'Waive the second factor'}
                    </Button>
                  </form>
                )}
                {provider.source === 'store' && provider.enabled && (
                  <ConfirmSubmit
                    action={`/api/admin/sign-in-providers/${encodeURIComponent(provider.id)}/disable`}
                    label="Switch off"
                    ariaLabel={`Switch ${provider.name} off`}
                    variant="ghost"
                    tone="danger"
                    title={`Switch ${provider.name} off?`}
                    consequence="Nobody signs in through it until it is on again, and the sessions of its people end — not yours. Refused if it is the last way in of every administrator."
                    confirmLabel="Switch off"
                    testId={`disable-provider-${provider.id}`}
                  />
                )}
                {provider.source === 'file' ? (
                  <Tag>{CONFIG_WORDS.file}</Tag>
                ) : (
                  <>
                    <ButtonLink
                      href={signInProviderPage(provider.id)}
                      size="sm"
                      aria-label={`${SETTINGS_ACTIONS.edit} ${provider.name}`}
                    >
                      {SETTINGS_ACTIONS.edit}
                    </ButtonLink>
                    <ConfirmSubmit
                      action={`/api/admin/sign-in-providers/${encodeURIComponent(provider.id)}/remove`}
                      label={SETTINGS_ACTIONS.remove}
                      ariaLabel={`${SETTINGS_ACTIONS.remove} ${provider.name}`}
                      variant="danger"
                      tone="danger"
                      title={`Remove ${provider.name}?`}
                      consequence={
                        people === 0 ? (
                          <>
                            Nobody has signed in through it yet. Nobody can sign in through it
                            after.
                          </>
                        ) : (
                          <>
                            {people} {people === 1 ? 'person has' : 'people have'} signed in through
                            it. At once they can no longer sign in, and their open sessions end.
                            Their missions, keys and connected apps keep running, as for anyone the
                            provider no longer vouches for: deactivate them on People to stop those.
                            Added again later with the same address, the provider gives them back
                            the same accounts.
                          </>
                        )
                      }
                      confirmLabel={SETTINGS_ACTIONS.remove}
                      testId={`remove-provider-${provider.id}`}
                    />
                  </>
                )}
              </span>
            )}
            testId="sign-in-providers"
          />
        )}
        <Hint>
          Administrators:{' '}
          {administrators.designations.length === 0
            ? 'nobody yet'
            : `${administrators.designations.length} named under People`}
          . A provider where anyone can open an account — GitHub, personal Google or Microsoft
          accounts — admits only allowed domains and invited people; the gateway never joins two
          accounts of one person.
        </Hint>
      </Section>
    </>
  );
}
