/**
 * `/admin/first-administrator` — the setup creates the first administrator's
 * local account (ADR local-accounts-sign-in-provider, D7): an address of the
 * admin rule, a password twice. The account's first sign-in enrols the second
 * factor, shows the recovery codes, and retires the bootstrap token.
 */
import styles from '@/components/settings/settings.module.css';
import {
  Button,
  ButtonLink,
  Callout,
  Field,
  Hint,
  Input,
  PageHeader,
  Section,
  Select,
} from '@/components/ui';
import { requireOperator } from '@/lib/auth/session';
import { SETTINGS_PAGES } from '@/lib/vocabulary';
import { PASSWORD_MIN_LENGTH } from '@/server/crypto/password';
import { ADMIN_SETUP_PAGE, USERS_PAGE } from '@/server/users';

export const dynamic = 'force-dynamic';

export default async function FirstAdministratorPage() {
  const { root } = await requireOperator();
  const providers = await root.auth.providers.views();
  const local = providers.find((p) => p.kind === 'local') ?? null;
  const candidates: string[] = [];
  for (const email of root.config.admin.emails) {
    if (local && !(await root.auth.accounts.accountOf(local.id, email))) candidates.push(email);
  }

  return (
    <>
      <PageHeader
        title="Create the first administrator"
        lede="An address the admin rule names, and the password it will sign in with. The second factor comes at the first sign-in."
        crumbs={[{ label: SETTINGS_PAGES.setup.title, href: ADMIN_SETUP_PAGE }]}
        width="narrow"
      />
      <Section first>
        {!local ? (
          <Callout tone="neutral" title="No local accounts yet" testId="first-admin-no-provider">
            Add local accounts under Sign-in first, or sign in through the provider you set up: an
            administrator of that provider needs no local account.
          </Callout>
        ) : candidates.length === 0 ? (
          <Callout tone="ok" title="Nothing to create" testId="first-admin-done">
            Every address the admin rule names already has its account.{' '}
            <ButtonLink href={USERS_PAGE} size="sm">
              People
            </ButtonLink>
          </Callout>
        ) : (
          <form
            method="post"
            action={`${USERS_PAGE}/first-administrator`}
            className={styles.form}
            data-testid="first-admin-form"
          >
            <Field
              label="Address"
              htmlFor="first-admin-email"
              hint="One of the admin rule's emails (admin.emails in the configuration). A rule made of a group alone cannot name a local account."
            >
              <Select id="first-admin-email" name="email" defaultValue={candidates[0]} required>
                {candidates.map((email) => (
                  <option key={email} value={email}>
                    {email}
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              label="Password"
              htmlFor="first-admin-password"
              shape={`${PASSWORD_MIN_LENGTH} characters or more`}
            >
              <Input
                id="first-admin-password"
                name="password"
                type="password"
                autoComplete="new-password"
                minLength={PASSWORD_MIN_LENGTH}
                required
              />
            </Field>
            <Field label="The same password again" htmlFor="first-admin-password-again">
              <Input
                id="first-admin-password-again"
                name="password_again"
                type="password"
                autoComplete="new-password"
                minLength={PASSWORD_MIN_LENGTH}
                required
              />
            </Field>
            <Hint>
              Choose it with the person who will administer this gateway, or let them type it here.
              Nobody can open the account for them afterwards: a lost password is reset with a link
              from People, a lost second factor with their recovery codes.
            </Hint>
            <div className={styles.formActions}>
              <Button type="submit" variant="primary">
                Create the account
              </Button>
              <ButtonLink href={ADMIN_SETUP_PAGE} variant="ghost">
                Cancel
              </ButtonLink>
            </div>
          </form>
        )}
      </Section>
    </>
  );
}
