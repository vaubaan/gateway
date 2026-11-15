/**
 * `/admin/recover` — recovery by the master key, loudly (ADR
 * administrators-live-in-the-instance §9). Outside every guarded layout: whoever
 * reaches it holds no session. The key file is read in the browser and proves its
 * holder without leaving it (`RecoverWithKey`); a passed proof opens a recovery
 * session that can do one thing — name an administrator —, after which the page says
 * what was named, once. Every naming is audited, mailed to the administrators when the
 * gateway sends mail, and shown on every page for thirty days.
 */
import { cookies } from 'next/headers';

import { AuthHeading, AuthPage } from '@/components/auth/AuthPage';
import styles from '@/components/auth/auth.module.css';
import { RecoverWithKey } from '@/components/auth/RecoverWithKey';
import { BuildFooter } from '@/components/shell/BuildFooter';
import { Button, ButtonLink, Callout, Field, Input, Mono, Select } from '@/components/ui';
import { currentPrincipal } from '@/lib/auth/session';
import { instanceMetadata } from '@/lib/instance';
import { RECOVER_DONE_PARAM, takeRecoveryOutcome } from '@/server/auth';

export const dynamic = 'force-dynamic';

export const generateMetadata = instanceMetadata;

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function RecoverPage({ searchParams }: Props) {
  const params = await searchParams;
  const { root } = await currentPrincipal();
  const instance = await root.instance.name.identity();
  const doneId = typeof params[RECOVER_DONE_PARAM] === 'string' ? params[RECOVER_DONE_PARAM] : null;
  const outcome = await takeRecoveryOutcome(root.sessions, doneId);
  const jar = await cookies();
  const headers = new Headers({
    cookie: jar
      .getAll()
      .map((c) => `${c.name}=${c.value}`)
      .join('; '),
  });
  const open = !outcome && (await root.auth.recovery.isOpen(headers));
  const signInProviders = open ? await root.auth.signInProviders.views() : [];
  const users = open ? (await root.store.users.list()).filter((u) => u.status === 'active') : [];

  return (
    <AuthPage instance={instance} footer={<BuildFooter />}>
      <AuthHeading title="Recover with the master key">
        For a gateway nobody can administer any more. Whoever holds its master key can name one
        administrator here — and only that. It is recorded, mailed to the administrators when this
        gateway sends mail, and shown on every page for thirty days.
      </AuthHeading>

      {outcome ? (
        <div className={styles.block}>
          {outcome.problem ? (
            <Callout tone="bad" title="Nobody was named" testId="recover-problem">
              {outcome.problem}
            </Callout>
          ) : (
            <Callout tone="ok" title="An administrator was named" testId="recover-done">
              <Mono>{JSON.stringify(outcome.named)}</Mono>
              {outcome.signInAccountLink && (
                <>
                  {' '}
                  Hand this link to the person to create their account; it works once, for fifteen
                  minutes, and is shown only now: <Mono>{outcome.signInAccountLink}</Mono>
                </>
              )}
            </Callout>
          )}
          <div className={styles.act}>
            <ButtonLink href="/login" variant="primary">
              Sign in
            </ButtonLink>
          </div>
        </div>
      ) : open ? (
        <div className={styles.block} data-testid="recover-name">
          <Callout tone="info" title="The key is this gateway’s">
            Name one administrator. This session ends with it, and lasts fifteen minutes.
          </Callout>
          {users.length > 0 && (
            <form method="post" action="/api/recover/name" className={styles.field}>
              <input type="hidden" name="kind" value="user" />
              <Field label="A person who has signed in" htmlFor="recover-user">
                <Select id="recover-user" name="user" required>
                  {users.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.email}
                    </option>
                  ))}
                </Select>
              </Field>
              <Button type="submit" variant="primary">
                Make them administrator
              </Button>
            </form>
          )}
          <form method="post" action="/api/recover/name" className={styles.field}>
            <input type="hidden" name="kind" value="email" />
            <Field label="Or an address, through a sign-in provider" htmlFor="recover-email">
              <Input id="recover-email" name="email" type="email" required />
            </Field>
            <Field label="Sign-in provider" htmlFor="recover-email-sign-in-provider">
              <Select id="recover-email-sign-in-provider" name="sign_in_provider" required>
                {signInProviders.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Button type="submit">Name this address</Button>
          </form>
          <form method="post" action="/api/recover/name" className={styles.field}>
            <input type="hidden" name="kind" value="group" />
            <Field
              label="Or a group of a sign-in provider (GitHub: a team, org/team)"
              htmlFor="recover-group"
            >
              <Input id="recover-group" name="group" required />
            </Field>
            <Field label="Sign-in provider" htmlFor="recover-group-sign-in-provider">
              <Select id="recover-group-sign-in-provider" name="sign_in_provider" required>
                {signInProviders
                  .filter((p) => p.kind !== 'local')
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
              </Select>
            </Field>
            <Button type="submit">Name this group</Button>
          </form>
        </div>
      ) : (
        <div className={styles.block}>
          <RecoverWithKey />
        </div>
      )}
    </AuthPage>
  );
}
