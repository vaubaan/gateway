/**
 * `/admin/identity-provider/<id>` — edit a sign-in provider saved in Settings.
 * Its id and kind do not change; the secret is never shown back (blank keeps
 * it, unless the address changes). A provider set by the mounted configuration
 * has no page here: it is changed where it is set.
 */
import { notFound } from 'next/navigation';

import {
  admissionOf,
  LocalSignInProviderForm,
  SignInProviderForm,
} from '@/components/settings/SignInProviderForm';
import styles from '@/components/settings/settings.module.css';
import { Callout, PageHeader, Section } from '@/components/ui';
import { requireOperator } from '@/lib/auth/session';
import { SETTINGS_PAGES } from '@/lib/vocabulary';
import { DEFAULT_CLAIM_MAPPING, IDP_PAGE } from '@/server/auth';

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
  const provider = await root.auth.providers.view(decodeURIComponent(id));
  if (!provider || provider.source === 'file') notFound();
  const github = provider.kind === 'github';

  return (
    <>
      <PageHeader
        title={provider.name}
        lede={`${provider.kind === 'local' ? 'Local accounts' : github ? 'GitHub' : 'OpenID Connect'} provider ${provider.id}. Saving applies to the next sign-ins.`}
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
        {provider.kind === 'local' ? (
          <LocalSignInProviderForm
            mode="update"
            id={provider.id}
            name={provider.name}
            cancelHref={IDP_PAGE}
          />
        ) : (
          <SignInProviderForm
            mode="update"
            values={{
              kind: provider.kind,
              id: provider.id,
              name: provider.name,
              issuer:
                github && provider.issuer.hostname === 'github.com' ? '' : provider.issuer.href,
              clientId: provider.clientId,
              claims: provider.kind === 'oidc' ? provider.claims : DEFAULT_CLAIM_MAPPING,
              domains: provider.allowedEmailDomains.join(' '),
              admission: admissionOf(provider),
            }}
            hasSecret
            callbackUrl={root.auth.flows.callbackUrl(provider.id).href}
            cancelHref={IDP_PAGE}
          />
        )}
      </Section>
    </>
  );
}
