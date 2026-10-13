/**
 * `/admin/provider-apps` — Company apps: what the company registered at each
 * service (spec §4.2 "Administration", §4.3, §7.1). One line per service that
 * needs an app; "Register" or "Edit" opens its form under the line
 * (`?app=<id>`), with fields derived from the plugin's `CredentialSpec`.
 * Secrets are sealed in `instance_config` and never echoed. A service set by
 * the mounted configuration is read-only here (the file wins).
 *
 * An app that is installed (`app-install`) says how its installations are
 * bound to the person who connects: verified by the gateway, or — for a
 * plugin that cannot prove it — refused until an administrator explicitly
 * accepts unverified installations, with a warning.
 */
import { CredentialFieldInputs, NoticeBanner } from '@/components/connections/parts';
import styles from '@/components/settings/settings.module.css';
import {
  Button,
  ButtonLink,
  Callout,
  CodeBlock,
  DataTable,
  Hint,
  PageHeader,
  Section,
  ServiceMark,
  StatusMark,
  Tag,
  type Column,
} from '@/components/ui';
import { requireOperator } from '@/lib/auth/session';
import { firstParam, takeNotice, type PageSearchParams } from '@/lib/connections/session';
import {
  ACCOUNT_WORDS,
  ACTIONS,
  CONFIG_WORDS,
  SETTINGS_ACTIONS,
  SETTINGS_PAGES,
} from '@/lib/vocabulary';
import {
  ACCEPT_UNVERIFIED_ACTION,
  PROVIDER_APPS_PAGE,
  REFUSE_UNVERIFIED_ACTION,
} from '@/server/connections';
import type { ProviderAppStatus } from '@/server/provider-apps';

export const dynamic = 'force-dynamic';

/** The query parameter that opens the form of one service. */
const APP_PARAM = 'app';

function listOf(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** What is registered, in a few words, and the exception when there is one. */
function RegisteredAs({ app }: { app: ProviderAppStatus }) {
  if (app.installVerification === 'unverified-accepted') {
    return <StatusMark tone="bad">Unverified installations accepted</StatusMark>;
  }
  if (app.installVerification === 'unverified-refused') {
    return <StatusMark tone="warn">Cannot verify installations</StatusMark>;
  }
  if (app.configured) {
    return (
      <span className={styles.inline}>
        registered
        {app.source === 'file' && <Tag>{CONFIG_WORDS.file}</Tag>}
        {app.installVerification === 'verified' && (
          <span className={styles.quiet}>· installations verified</span>
        )}
      </span>
    );
  }
  if (app.source === 'none') return <span className={styles.quiet}>not registered</span>;
  return <StatusMark tone="warn">Incomplete: {app.missing.join(', ')} missing</StatusMark>;
}

/**
 * Shown only for an installed app whose plugin cannot prove who performed an
 * installation. Its own form, outside the fields' fieldset: the decision is
 * the administrator's whatever the source of the fields.
 */
function UnverifiedInstallations({ app, action }: { app: ProviderAppStatus; action: string }) {
  if (app.installVerification === null || app.installVerification === 'verified') return null;
  const accepted = app.installVerification === 'unverified-accepted';
  return (
    <Callout
      tone={accepted ? 'bad' : 'warn'}
      title={
        accepted
          ? 'Unverified installations are accepted'
          : `${app.displayName} cannot verify installations`
      }
      action={
        <form method="post" action={action}>
          <Button
            type="submit"
            size="sm"
            name="action"
            value={accepted ? REFUSE_UNVERIFIED_ACTION : ACCEPT_UNVERIFIED_ACTION}
            variant={accepted ? 'primary' : 'danger'}
          >
            {accepted ? 'Refuse unverified installations' : 'Accept unverified installations'}
          </Button>
        </form>
      }
    >
      The plugin of {app.displayName} does not let the gateway check that the person who connects an
      installation has access to it. If you accept unverified installations, anyone signed in who
      knows the id of an installation of this app — another team’s, another company’s — can connect
      it and write missions on it.
      {accepted ? '' : ' Until you accept, nobody can connect this service.'}
    </Callout>
  );
}

function AppForm({ app, callbackUrl }: { app: ProviderAppStatus; callbackUrl: string }) {
  const readOnly = app.source === 'file';
  const action = `${PROVIDER_APPS_PAGE}/${encodeURIComponent(app.providerId)}`;
  return (
    <div className={styles.detail} data-testid={`app-form-${app.providerId}`}>
      <div className={styles.block}>
        <p className={styles.quiet}>
          {app.credentialKind === 'oauth2'
            ? `Redirect address to register at ${app.displayName}:`
            : app.installVerification === 'verified'
              ? `Callback address to register at ${app.displayName}, with user authorization requested during installation:`
              : `Setup address (redirect after installation) to register at ${app.displayName}:`}
        </p>
        <CodeBlock label="Address to register">{callbackUrl}</CodeBlock>
      </div>
      {app.installVerification === 'verified' && (
        <p className={styles.prose}>
          An installation is connected only after {app.displayName} confirms that the person who
          authorized the app can reach it. The app must request user authorization during
          installation; without it every attempt to connect is refused.
        </p>
      )}
      <UnverifiedInstallations app={app} action={action} />
      <form method="post" action={action} className={styles.form}>
        <fieldset disabled={readOnly} className={styles.fieldset}>
          <CredentialFieldInputs
            idPrefix={`provider-app-${app.providerId}`}
            fields={app.fields}
            values={app.values}
            secretsSet={app.secretsSet}
            disabled={readOnly}
          />
          <div className={styles.formActions}>
            <Button type="submit" variant="primary" size="sm" disabled={readOnly}>
              {SETTINGS_ACTIONS.save}
            </Button>
            {app.source === 'store' && (
              <Button
                type="submit"
                name="action"
                value="clear"
                variant="danger"
                size="sm"
                formNoValidate
              >
                {SETTINGS_ACTIONS.remove}
              </Button>
            )}
            <ButtonLink href={PROVIDER_APPS_PAGE} variant="ghost" size="sm">
              {ACTIONS.cancel}
            </ButtonLink>
            {readOnly && <span className={styles.formHint}>{CONFIG_WORDS.fileReadOnly}</span>}
          </div>
        </fieldset>
      </form>
    </div>
  );
}

export default async function CompanyAppsPage({
  searchParams,
}: {
  searchParams: PageSearchParams;
}) {
  const { root, principal } = await requireOperator();
  const params = await searchParams;
  const notice = await takeNotice(root, principal.sessionId, params);
  const apps = await root.providerApps.list();
  const withApp = apps.filter((app) => app.needsApp);
  const withoutApp = apps.filter((app) => !app.needsApp);
  const opened = firstParam(params[APP_PARAM]);

  const columns: readonly Column<ProviderAppStatus>[] = [
    {
      id: 'service',
      header: 'Service',
      cell: (app) => (
        <span className={styles.named} id={app.providerId}>
          <ServiceMark name={app.displayName} />
          <span className={styles.name}>{app.displayName}</span>
          {app.experimental && <Tag>{ACCOUNT_WORDS.experimental}</Tag>}
        </span>
      ),
    },
    {
      id: 'registered',
      header: 'Registered as',
      cell: (app) => <RegisteredAs app={app} />,
    },
  ];

  return (
    <>
      <PageHeader title={SETTINGS_PAGES.companyApps.title} lede={SETTINGS_PAGES.companyApps.lede} />
      <NoticeBanner notice={notice} />
      <Section first>
        <DataTable
          caption="The app your company registered at each service"
          columns={columns}
          rows={withApp}
          rowKey={(app) => app.providerId}
          actions={(app) => (
            <ButtonLink
              href={`${PROVIDER_APPS_PAGE}?${APP_PARAM}=${encodeURIComponent(app.providerId)}#${app.providerId}`}
              size="sm"
              aria-label={`${app.configured ? SETTINGS_ACTIONS.edit : SETTINGS_ACTIONS.register} the ${app.displayName} app`}
            >
              {app.configured ? SETTINGS_ACTIONS.edit : SETTINGS_ACTIONS.register}
            </ButtonLink>
          )}
          rowDetail={(app) =>
            opened === app.providerId ? (
              <AppForm
                app={app}
                callbackUrl={root.connections.service.callbackUrl(app.providerId).href}
              />
            ) : null
          }
          empty={<Hint>No service of this gateway needs a company app.</Hint>}
          testId="company-apps"
        />
        <Hint>
          You register one app per service at the service itself, then enter what it gave you here;
          the gateway ships no shared app.
          {withoutApp.length > 0 &&
            ` ${listOf(withoutApp.map((app) => app.displayName))} connect with a key and need nothing here.`}
        </Hint>
      </Section>
    </>
  );
}
