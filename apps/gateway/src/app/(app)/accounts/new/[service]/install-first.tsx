/**
 * The first connection of a service the instance has no plugin for (ADR
 * plugins-installed-when-first-needed): what installing it means, and the one button that
 * installs the catalog's version and goes on to the connection. A POST, never a page that
 * installs on its own.
 */
import { Button, Callout, Mono, PageHeader, Section } from '@/components/ui';
import { ACCOUNT_PAGES, INSTALL_WORDS, PAGES, ROUTES } from '@/lib/vocabulary';

export function InstallFirst({
  serviceId,
  version,
  problem,
  detail,
}: {
  serviceId: string;
  version: string;
  problem: string | null;
  detail: string | null;
}) {
  const problems = INSTALL_WORDS.problems as Readonly<Record<string, string>>;
  return (
    <>
      <PageHeader
        crumbs={[
          { label: PAGES.accounts.title, href: ROUTES.accounts },
          { label: ACCOUNT_PAGES.connect.title, href: `${ROUTES.accounts}/new` },
        ]}
        title={INSTALL_WORDS.firstInstallTitle(serviceId)}
        lede={INSTALL_WORDS.firstInstallLede}
      />
      {problem !== null && (
        <Callout tone="bad" title={INSTALL_WORDS.firstInstallFailed} testId="install-problem">
          {problems[problem] ?? problem}
          {detail ? `: ${detail}` : '.'}
        </Callout>
      )}
      <Section first>
        <form
          method="post"
          action={`${ROUTES.accounts}/new/${encodeURIComponent(serviceId)}/install`}
          data-testid="install-first"
        >
          <p>
            <Mono>{serviceId}</Mono> <Mono>{version}</Mono>
          </p>
          <Button type="submit" variant="primary" data-testid="install-and-connect">
            {INSTALL_WORDS.firstInstall}
          </Button>
        </form>
      </Section>
    </>
  );
}
