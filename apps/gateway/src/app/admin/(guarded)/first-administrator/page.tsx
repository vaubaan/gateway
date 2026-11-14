/**
 * `/admin/first-administrator` — the setup creates the first administrator's
 * sign-in account (ADR administrators-live-in-the-instance, §4): any address, a
 * password twice. The account administers from its creation; its first sign-in
 * enrols the second factor and shows the recovery codes.
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
} from '@/components/ui';
import { requireOperator } from '@/lib/auth/session';
import { DOC_PAGES, SETTINGS_PAGES } from '@/lib/vocabulary';
import { PASSWORD_MIN_LENGTH } from '@/server/crypto/password';
import { ADMIN_SETUP_PAGE, USERS_PAGE } from '@/server/users';

export const dynamic = 'force-dynamic';

export default async function FirstAdministratorPage() {
  const { root } = await requireOperator();
  const providers = await root.auth.providers.views();
  const local = providers.find((p) => p.kind === 'local') ?? null;

  return (
    <>
      <PageHeader
        doc={DOC_PAGES.firstAdministrator}
        title="Create the first administrator"
        lede="The address and the password the first administrator will sign in with. The second factor comes at the first sign-in."
        crumbs={[{ label: SETTINGS_PAGES.setup.title, href: ADMIN_SETUP_PAGE }]}
        width="narrow"
      />
      <Section first>
        {!local ? (
          <Callout tone="neutral" title="No sign-in accounts yet" testId="first-admin-no-provider">
            Add sign-in accounts under Sign-in first, or sign in through the provider you set up: an
            administrator of that provider needs no sign-in account.
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
              hint="The administrator's own address: it receives the password resets once this gateway sends mail."
            >
              <Input id="first-admin-email" name="email" type="email" autoComplete="off" required />
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
