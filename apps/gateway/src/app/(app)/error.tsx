'use client';

/**
 * A page of the application failed while rendering. The shell stays; the page
 * says what is known — loading a page changes nothing — and offers to try
 * again. The reference is the digest the server logged the error under: it
 * says nothing by itself and lets an administrator find the entry.
 */
import { Button, ButtonLink, EmptyState, Mono, PageHeader } from '@/components/ui';
import { PAGES, ROUTES } from '@/lib/vocabulary';

export default function PageError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <>
      <PageHeader title="Something went wrong" />
      <EmptyState
        testId="page-error"
        title="This page could not be shown."
        action={
          <Button variant="primary" onClick={reset}>
            Try again
          </Button>
        }
        links={
          <ButtonLink href={ROUTES.home} variant="ghost">
            Go to {PAGES.now.title}
          </ButtonLink>
        }
      >
        Nothing was changed by opening it. If it keeps happening, tell your administrator
        {error.digest ? (
          <>
            {' '}
            and quote <Mono>{error.digest}</Mono>
          </>
        ) : null}
        .
      </EmptyState>
    </>
  );
}
