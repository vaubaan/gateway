/**
 * `/admin/identity-provider/new?kind=oidc|github` — add a sign-in provider.
 * The address to register at the provider is shown first, since the provider
 * asks for it before it hands over a client id and secret. A refused form comes
 * back as it was typed, never the secret.
 */
import {
  LocalSignInProviderForm,
  SignInProviderForm,
  type AdmissionChoice,
} from '@/components/settings/SignInProviderForm';
import styles from '@/components/settings/settings.module.css';
import { Callout, PageHeader, Section, Segmented } from '@/components/ui';
import { requireOperator } from '@/lib/auth/session';
import { SETTINGS_PAGES } from '@/lib/vocabulary';
import { DEFAULT_CLAIM_MAPPING, IDP_PAGE, NEW_SIGN_IN_PROVIDER_PAGE } from '@/server/auth';
import { DEFAULT_LOCAL_PROVIDER_ID } from '@/server/config';

export const dynamic = 'force-dynamic';

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function first(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? '';
}

function admissionChoice(raw: string, github: boolean): AdmissionChoice {
  if (raw === 'everyone' || raw === 'domains' || raw === 'invited') return raw;
  return github ? 'invited' : 'everyone';
}

export default async function NewSignInProviderPage({ searchParams }: Props) {
  const { root } = await requireOperator();
  const params = await searchParams;
  const requested = first(params.kind);
  const kind = requested === 'github' ? 'github' : requested === 'local' ? 'local' : 'oidc';
  const github = kind === 'github';
  const local = kind === 'local';
  const problems = ([] as string[]).concat(params.problem ?? []);
  const taken = new Set((await root.auth.providers.views()).map((p) => p.id));
  const suggested =
    github && !taken.has('github')
      ? 'github'
      : local && !taken.has(DEFAULT_LOCAL_PROVIDER_ID)
        ? DEFAULT_LOCAL_PROVIDER_ID
        : '';
  const id = first(params.id) || suggested;
  const callback = root.auth.flows.callbackUrl(id || 'your-id').href;

  return (
    <>
      <PageHeader
        title={
          local ? 'Add local accounts' : github ? 'Add GitHub sign-in' : 'Add a sign-in provider'
        }
        lede={
          local
            ? 'People sign in with an email address, a password and a code from their authenticator app, all kept by this gateway. For a company without a directory.'
            : github
              ? 'People sign in with their own GitHub account; the gateway admits allowed domains and invited people only.'
              : 'Your company’s directory, or a public service, through OpenID Connect.'
        }
        crumbs={[{ label: SETTINGS_PAGES.signIn.title, href: IDP_PAGE }]}
        width="narrow"
      />
      <Section first>
        <Segmented
          label="Kind of provider"
          value={kind}
          options={[
            {
              value: 'oidc',
              label: 'OpenID Connect',
              href: `${NEW_SIGN_IN_PROVIDER_PAGE}?kind=oidc`,
            },
            { value: 'github', label: 'GitHub', href: `${NEW_SIGN_IN_PROVIDER_PAGE}?kind=github` },
            {
              value: 'local',
              label: 'Local accounts',
              href: `${NEW_SIGN_IN_PROVIDER_PAGE}?kind=local`,
            },
          ]}
        />
        {problems.length > 0 && (
          <div className={styles.notes}>
            <Callout tone="bad" title="Not added" testId="idp-problems">
              <ul className={styles.list}>
                {problems.map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            </Callout>
          </div>
        )}
        {local ? (
          <>
            <p className={styles.prose}>
              Nothing to register anywhere. Once added, invite people from People: each receives a
              link to create their account, and you create the first administrator from Setup.
            </p>
            <LocalSignInProviderForm
              mode="create"
              id={id}
              name={first(params.name)}
              cancelHref={IDP_PAGE}
            />
          </>
        ) : (
          <>
            <p className={styles.prose}>
              {github
                ? 'At GitHub, under Settings → Developer settings → OAuth Apps (of your organisation or your own account), register a new OAuth App with the callback address below, generate a client secret, and paste both here.'
                : 'At your provider, register a web application with the redirect address below and the scopes openid, profile and email; paste its client id and secret here.'}
            </p>
            <SignInProviderForm
              mode="create"
              values={{
                kind,
                id,
                name: first(params.name),
                issuer: first(params.issuer),
                clientId: first(params.client_id),
                claims: {
                  sub: first(params.claim_sub) || DEFAULT_CLAIM_MAPPING.sub,
                  email: first(params.claim_email) || DEFAULT_CLAIM_MAPPING.email,
                  groups: first(params.claim_groups) || DEFAULT_CLAIM_MAPPING.groups,
                },
                domains: first(params.allowed_email_domains),
                admission: admissionChoice(first(params.admission), github),
              }}
              hasSecret={false}
              callbackUrl={callback}
              cancelHref={IDP_PAGE}
            />
          </>
        )}
      </Section>
    </>
  );
}
