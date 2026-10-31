/**
 * `/admin/identity-provider/<id>/test` — what the last test of a sign-in provider
 * found (ADR administrators-live-in-the-instance, §5): the provider ran its sign-in
 * to the end in another window, and the gateway signed nobody in. The page shows
 * what the provider returned and the verdict a sign-in would get; from the result
 * the tester switches the provider on, or makes the tested identity an
 * administrator (the setup through a provider).
 */
import { notFound } from 'next/navigation';

import styles from '@/components/settings/settings.module.css';
import {
  Button,
  ButtonLink,
  Callout,
  KeyValue,
  Mono,
  PageHeader,
  Section,
  Tag,
} from '@/components/ui';
import { LocalDate } from '@/components/LocalDate';
import { requireOperator } from '@/lib/auth/session';
import { SETTINGS_PAGES } from '@/lib/vocabulary';
import {
  IDP_PAGE,
  isLoginErrorCode,
  LOGIN_ERROR_MESSAGES,
  signInTestPath,
  testPassedSinceSaved,
} from '@/server/auth';

export const dynamic = 'force-dynamic';

interface Props {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const REASON_WORDS: Readonly<Record<string, string>> = {
  'everyone-of-the-directory': 'everyone the directory signs in',
  domain: 'an allowed domain',
  invitation: 'an invitation',
  administrator: 'an administrator of this gateway',
};

export default async function SignInTestPage({ params, searchParams }: Props) {
  const { root, principal } = await requireOperator();
  const { id } = await params;
  const query = await searchParams;
  const provider = await root.auth.providers.view(id);
  if (!provider) notFound();
  const state = await root.auth.providers.state(id);
  const test = state.test;
  const problems = ([] as string[]).concat(query.problem ?? []);
  const madeAdministrator = query.administrator === '1';
  const mine = test !== null && test.sessionId === principal.sessionId;
  const identity = test?.identity ?? null;
  const verdict = test?.verdict ?? null;

  return (
    <>
      <PageHeader
        title={`Test of ${provider.name}`}
        lede="The provider ran its sign-in to the end in another window. Nothing was created here: no person, no session; your own session is untouched."
        crumbs={[{ label: SETTINGS_PAGES.signIn.title, href: IDP_PAGE }]}
        width="narrow"
      />
      <Section first>
        {problems.length > 0 && (
          <Callout tone="bad" title="Not done" testId="test-problems">
            <ul className={styles.list}>
              {problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          </Callout>
        )}
        {madeAdministrator && identity && (
          <Callout
            tone="ok"
            title={`${identity.email} administers this gateway`}
            testId="test-made-administrator"
          >
            Their first sign-in through {provider.name} sets their second factor up.
          </Callout>
        )}
        {!test ? (
          <Callout tone="neutral" title="Not tested yet" testId="test-none">
            Use “Test” on the sign-in page of the settings.
          </Callout>
        ) : test.outcome === 'failed' ? (
          <Callout tone="bad" title="The test failed" testId="test-failed">
            {test.error && isLoginErrorCode(test.error)
              ? LOGIN_ERROR_MESSAGES[test.error]
              : 'The provider refused the sign-in.'}
            {test.detail && <span className={styles.sub}>{test.detail}</span>}
          </Callout>
        ) : (
          <Callout
            tone={verdict?.admitted ? 'ok' : 'neutral'}
            title={
              verdict?.administrator
                ? 'Passed: this person would sign in as an administrator'
                : verdict?.admitted
                  ? 'Passed: this person would sign in'
                  : 'Passed: the provider works, and this person would be refused'
            }
            testId="test-passed"
          >
            <KeyValue
              items={[
                { term: 'Provider', value: <Mono>{provider.id}</Mono> },
                { term: 'Subject', value: <Mono>{identity?.subject ?? '—'}</Mono> },
                {
                  term: 'Email',
                  value: (
                    <span className={styles.inline}>
                      {identity?.email ?? '—'}
                      <Tag>{identity?.emailVerified ? 'verified' : 'not said to be verified'}</Tag>
                    </span>
                  ),
                },
                {
                  term: 'Groups',
                  value:
                    !identity || identity.groups.length === 0 ? (
                      <span className={styles.quiet}>none returned</span>
                    ) : (
                      <span className={styles.inline}>
                        {identity.groups.map((group) => (
                          <Tag key={group} mono>
                            {group}
                          </Tag>
                        ))}
                      </span>
                    ),
                },
                ...(identity?.amr
                  ? [{ term: 'Authentication methods', value: identity.amr.join(', ') }]
                  : []),
                {
                  term: 'Verdict',
                  value: verdict?.admitted
                    ? `admitted by ${REASON_WORDS[verdict.reason ?? ''] ?? verdict.reason}${verdict.administrator ? ', as administrator' : ', as a user'}`
                    : verdict?.refusal && isLoginErrorCode(verdict.refusal)
                      ? `refused: ${LOGIN_ERROR_MESSAGES[verdict.refusal]}`
                      : 'refused',
                },
                { term: 'Tested', value: <LocalDate ts={test.at} /> },
              ]}
            />
          </Callout>
        )}
        <div className={styles.formActions}>
          {provider.kind !== 'local' && (
            <form method="post" action={signInTestPath(provider.id)} target="_blank">
              <Button type="submit">Test again</Button>
            </form>
          )}
          {provider.source === 'store' && !provider.enabled && testPassedSinceSaved(state) && (
            <form
              method="post"
              action={`/api/admin/sign-in-providers/${encodeURIComponent(provider.id)}/enable`}
            >
              <Button type="submit" variant="primary" data-testid="test-enable">
                Switch it on
              </Button>
            </form>
          )}
          {mine && test?.outcome === 'passed' && identity && !verdict?.administrator && (
            <form
              method="post"
              action={`/api/admin/sign-in-providers/${encodeURIComponent(provider.id)}/test/administrator`}
            >
              <Button type="submit" data-testid="test-make-administrator">
                Make {identity.email} an administrator
              </Button>
            </form>
          )}
          <ButtonLink href={IDP_PAGE} variant="ghost">
            Back to sign-in
          </ButtonLink>
        </div>
      </Section>
    </>
  );
}
