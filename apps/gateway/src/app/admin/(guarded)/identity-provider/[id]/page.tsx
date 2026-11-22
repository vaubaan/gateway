/**
 * `/admin/identity-provider/<id>` — edit a sign-in provider saved in Settings.
 * Its id and kind do not change; the secret is never shown back (blank keeps
 * it, unless the address changes). A sign-in provider set by the mounted configuration
 * has no page here: it is changed where it is set.
 */
import { notFound } from 'next/navigation';

import {
  admissionOf,
  LocalSignInProviderForm,
  SignInProviderForm,
} from '@/components/settings/SignInProviderForm';
import styles from '@/components/settings/settings.styles';
import { Callout, PageHeader, Section } from '@/components/ui';
import { requireOperator } from '@/lib/auth/session';
import { DOC_PAGES, SETTINGS_PAGES } from '@/lib/vocabulary';
import { DEFAULT_CLAIM_MAPPING, IDP_PAGE } from '@/server/auth';
import { entraTenantOf, GOOGLE_ISSUER, issuerKey } from '@/server/config';

export const dynamic = 'force-dynamic';

interface Props {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function SignInProviderPage({ params, searchParams }: Props) {
  const { root } = await requireOperator();
  const { id } = await params;
  const query = await searchParams;
  const problems = ([] as string[]).concat(query.problem ?? []);
  const signInProvider = await root.auth.signInProviders.view(decodeURIComponent(id));
  if (!signInProvider || signInProvider.source === 'file') notFound();
  const github = signInProvider.kind === 'github';
  // A sign-in provider saved from a preset is edited with the preset's fields (the Entra tenant).
  const tenant = signInProvider.kind === 'oidc' ? entraTenantOf(signInProvider.issuer) : null;
  const preset =
    signInProvider.kind === 'oidc'
      ? tenant
        ? ('entra' as const)
        : issuerKey(signInProvider.issuer) === GOOGLE_ISSUER
          ? ('google' as const)
          : undefined
      : undefined;

  return (
    <>
      <PageHeader
        doc={DOC_PAGES.signIn}
        title={signInProvider.name}
        lede={`${signInProvider.kind === 'local' ? 'Sign-in accounts' : github ? 'GitHub' : 'OpenID Connect'} sign-in provider ${signInProvider.id}. Saving applies to the next sign-ins.`}
        crumbs={[{ label: SETTINGS_PAGES.signIn.title, href: IDP_PAGE }]}
        width="narrow"
      />
      <Section first>
        {problems.length > 0 && (
          <div className={styles.notes}>
            <Callout tone="bad" title="Not saved" testId="idp-problems">
              <ul className={styles.list}>
                {problems.map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            </Callout>
          </div>
        )}
        {signInProvider.kind === 'local' ? (
          <LocalSignInProviderForm
            mode="update"
            id={signInProvider.id}
            name={signInProvider.name}
            cancelHref={IDP_PAGE}
          />
        ) : (
          <SignInProviderForm
            mode="update"
            values={{
              kind: signInProvider.kind,
              ...(preset ? { preset } : {}),
              ...(tenant ? { tenant } : {}),
              id: signInProvider.id,
              name: signInProvider.name,
              issuer:
                github && signInProvider.issuer.hostname === 'github.com'
                  ? ''
                  : signInProvider.issuer.href,
              clientId: signInProvider.clientId,
              claims:
                signInProvider.kind === 'oidc' ? signInProvider.claims : DEFAULT_CLAIM_MAPPING,
              domains: signInProvider.allowedEmailDomains.join(' '),
              admission: admissionOf(signInProvider),
            }}
            hasSecret
            callbackUrl={root.auth.flows.callbackUrl(signInProvider.id).href}
            cancelHref={IDP_PAGE}
          />
        )}
      </Section>
    </>
  );
}
