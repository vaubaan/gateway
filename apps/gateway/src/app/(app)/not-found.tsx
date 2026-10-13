/**
 * "Not found", inside the application shell: a mission, an account or a
 * service that does not exist — or that is not the reader's to see; the page
 * gives one answer for both.
 */
import { ButtonLink, EmptyState, PageHeader, SummaryLine } from '@/components/ui';
import { PAGES, ROUTES } from '@/lib/vocabulary';

export default function NotFoundInShell() {
  return (
    <>
      <PageHeader title="Not found" />
      <EmptyState
        testId="not-found"
        title="This page does not exist, or is not yours to see."
        action={
          <ButtonLink href={ROUTES.home} variant="primary">
            Go to {PAGES.now.title}
          </ButtonLink>
        }
        links={
          <SummaryLine
            centered
            items={[
              { label: PAGES.missions.title, href: ROUTES.missions },
              { label: PAGES.accounts.title, href: ROUTES.accounts },
              { label: PAGES.activity.title, href: ROUTES.activity },
            ]}
          />
        }
      >
        The address may be mistyped, or the thing it led to was removed.
      </EmptyState>
    </>
  );
}
