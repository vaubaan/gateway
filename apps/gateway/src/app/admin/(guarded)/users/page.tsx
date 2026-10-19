/**
 * `/admin/users` — People: everyone who signed in, and the administrator's
 * deactivation of one (spec §2.3 "creator removed from the IdP"; ADR
 * operator-deactivates-a-user). The gateway stores no directory: a person is
 * listed once they have signed in. Deactivating is offboarding without the
 * identity provider: no sign-in, no session, no key, connected apps
 * disconnected; their missions stop for want of an owner. The act is asked
 * first, with what it stops.
 *
 * Each person says the sign-in provider they signed in through: one person
 * signing in through two providers is two people here, and the gateway never
 * joins them. Under the list, the invitations: the addresses administrators
 * allowed to sign in (spec §0 "Invitation"), with "Invite" and "Remove" (asked
 * first: it stops the next sign-ins, not an open session).
 */
import styles from '@/components/settings/settings.module.css';
import { NoticeBanner } from '@/components/connections/parts';
import {
  Avatar,
  Button,
  ConfirmSubmit,
  DataTable,
  EmptyState,
  Field,
  Hint,
  Input,
  Mono,
  PageHeader,
  Section,
  type Column,
} from '@/components/ui';
import { requireOperator } from '@/lib/auth/session';
import { takeNotice, type PageSearchParams } from '@/lib/connections/session';
import {
  ago,
  qualifiers,
  ROLE_WORDS,
  SETTINGS_ACTIONS,
  SETTINGS_PAGES,
  shortDate,
} from '@/lib/vocabulary';
import { isOperator } from '@/server/auth';
import { issuerKey } from '@/server/config';
import { USERS_PAGE, type InvitationView, type UserView } from '@/server/users';

export const dynamic = 'force-dynamic';

const MS_PER_DAY = 86_400_000;

/** "now", "4 h", "yesterday", then the day: a sign-in of last month reads as a date. */
function lastSignIn(iso: string | null, now: Date): string {
  if (!iso) return 'never';
  return now.getTime() - new Date(iso).getTime() < 2 * MS_PER_DAY
    ? ago(iso, now)
    : shortDate(iso, now);
}

export default async function PeoplePage({ searchParams }: { searchParams: PageSearchParams }) {
  const { root, principal } = await requireOperator();
  const params = await searchParams;
  const notice = await takeNotice(root, principal.sessionId, params);
  const [users, invitations, providers, rule] = await Promise.all([
    root.users.service.list(),
    root.users.invitations.list(),
    root.auth.providers.views(),
    root.auth.providers.adminRule(),
  ]);
  const local = providers.find((p) => p.kind === 'local') ?? null;
  const sendsMail = root.auth.sendsMail;
  const isLocal = (view: UserView): boolean =>
    local !== null &&
    view.user.issuer !== null &&
    issuerKey(view.user.issuer) === issuerKey(local.issuer);
  const providerOf = (view: UserView): string => {
    const key = view.user.issuer === null ? null : issuerKey(view.user.issuer);
    return providers.find((p) => issuerKey(p.issuer) === key)?.name ?? 'a removed provider';
  };
  const self = principal.kind === 'user' ? principal.user.id : null;
  const now = new Date();
  const nameOf = (view: UserView) => view.user.displayName ?? view.user.email;

  const columns: readonly Column<UserView>[] = [
    {
      id: 'person',
      header: 'Person',
      cell: (view) => {
        const active = view.user.status === 'active';
        const administrator =
          active && isOperator({ email: view.user.email, groups: view.groupRecords }, rule);
        const words = qualifiers([
          view.user.id === self && ROLE_WORDS.you,
          administrator && ROLE_WORDS.admin,
        ]);
        return (
          <span className={styles.named}>
            <Avatar name={nameOf(view)} muted={!active} />
            <span className={styles.namedText}>
              <span>
                <span className={styles.name}>{nameOf(view)}</span>
                {words && <span className={styles.quiet}> {words}</span>}
              </span>
              {view.user.displayName && <span className={styles.sub}>{view.user.email}</span>}
            </span>
          </span>
        );
      },
    },
    {
      id: 'provider',
      header: 'Signed in with',
      cell: (view) => <span className={styles.quiet}>{providerOf(view)}</span>,
    },
    {
      id: 'teams',
      header: 'Teams',
      cell: (view) =>
        view.groups.length === 0 ? <span className={styles.quiet}>—</span> : view.groups.join(', '),
    },
    {
      id: 'sign-in',
      header: 'Last sign-in',
      nowrap: true,
      cell: (view) => (
        <span className={styles.quiet}>{lastSignIn(view.user.lastLoginAt, now)}</span>
      ),
    },
    {
      id: 'state',
      header: 'State',
      nowrap: true,
      cell: (view) =>
        view.user.status === 'active' ? (
          ''
        ) : (
          <span className={styles.quiet}>
            deactivated{view.user.removedAt ? ` ${shortDate(view.user.removedAt, now)}` : ''}
          </span>
        ),
    },
  ];

  const invitationColumns: readonly Column<InvitationView>[] = [
    { id: 'email', header: 'Address', cell: (invitation) => <Mono>{invitation.email}</Mono> },
    {
      id: 'by',
      header: 'Invited by',
      cell: (invitation) => <span className={styles.quiet}>{invitation.invitedBy ?? '—'}</span>,
    },
    {
      id: 'when',
      header: 'When',
      nowrap: true,
      cell: (invitation) => (
        <span className={styles.quiet}>{shortDate(invitation.createdAt, now)}</span>
      ),
    },
    {
      id: 'state',
      header: 'Signed in',
      nowrap: true,
      cell: (invitation) =>
        invitation.signedIn ? 'yes' : <span className={styles.quiet}>not yet</span>,
    },
  ];

  return (
    <>
      <PageHeader title={SETTINGS_PAGES.people.title} lede={SETTINGS_PAGES.people.lede} />
      <NoticeBanner notice={notice} />
      <Section first>
        {users.length === 0 ? (
          <EmptyState title="Nobody has signed in yet." testId="no-people" />
        ) : (
          <DataTable
            caption="Everyone who has signed in to this gateway"
            columns={columns}
            rows={users}
            rowKey={(view) => view.user.id}
            rowTone={(view) => (view.user.status === 'active' ? undefined : 'quiet')}
            actions={(view) => {
              const base = `${USERS_PAGE}/${encodeURIComponent(view.user.id)}`;
              if (view.user.status !== 'active') {
                return (
                  <form method="post" action={`${base}/reactivate`}>
                    <Button
                      type="submit"
                      size="sm"
                      aria-label={`Reactivate ${view.user.email}`}
                      title="They may sign in again. Teams from the identity provider return at that sign-in; local teams, connected apps and accounts given to someone else do not come back by themselves."
                    >
                      {SETTINGS_ACTIONS.reactivate}
                    </Button>
                  </form>
                );
              }
              if (view.user.id === self) return null;
              return (
                <>
                  {isLocal(view) && (
                    <form method="post" action={`${USERS_PAGE}/local-link`}>
                      <input type="hidden" name="kind" value="reset" />
                      <input type="hidden" name="email" value={view.user.email} />
                      <Button
                        type="submit"
                        size="sm"
                        variant="ghost"
                        aria-label={`Reset the password of ${view.user.email}`}
                        title={
                          sendsMail
                            ? 'Sends them a link to choose a new password; it works once, for fifteen minutes.'
                            : 'Gives you a link to hand them to choose a new password; it works once, for fifteen minutes.'
                        }
                        data-testid={`reset-password-${view.user.id}`}
                      >
                        Password reset
                      </Button>
                    </form>
                  )}
                  <form method="post" action={`${base}/end-sessions`}>
                    <Button
                      type="submit"
                      size="sm"
                      variant="secondary"
                      aria-label={`Sign ${view.user.email} out everywhere`}
                      title="Every browser they are signed in with must sign in again. Their keys, connected apps and missions are unchanged."
                      data-testid={`end-sessions-${view.user.id}`}
                    >
                      {SETTINGS_ACTIONS.endSessions}
                    </Button>
                  </form>
                  <ConfirmSubmit
                    action={`${base}/deactivate`}
                    label={SETTINGS_ACTIONS.deactivate}
                    ariaLabel={`Deactivate ${view.user.email}`}
                    variant="danger"
                    tone="danger"
                    title={`Deactivate ${nameOf(view)}?`}
                    consequence={
                      <>
                        At once, without waiting for the identity provider: they can no longer sign
                        in, their open sessions end, every key they hold is refused, the apps they
                        connected lose their access, and they leave every team. The missions they
                        created stop — every call is refused — and an account they were the last
                        owner of is listed under “{SETTINGS_PAGES.ownerless.title}”, for you to name
                        a new owner.
                      </>
                    }
                    confirmLabel={SETTINGS_ACTIONS.deactivate}
                    hint="You can reactivate them later; their missions then run again."
                    testId={`deactivate-${view.user.id}`}
                  />
                </>
              );
            }}
            testId="people"
          />
        )}
        <Hint>
          A person appears here once they have signed in. One person who signs in through two
          providers is two people here: the gateway never joins accounts by email. You cannot
          deactivate yourself: another administrator can.
        </Hint>
      </Section>

      <Section
        title="Invitations"
        note={
          local
            ? sendsMail
              ? 'Addresses allowed to sign in. With local accounts, inviting sends the person a link to create theirs.'
              : 'Addresses allowed to sign in. With local accounts, inviting gives you a link to hand to the person; this gateway sends no mail.'
            : 'Addresses allowed to sign in through any provider that verified them. Nothing is sent.'
        }
        testId="invitations"
      >
        <form method="post" action={`${USERS_PAGE}/invitations`} className={styles.lineForm}>
          <Field label="Email address" htmlFor="invite-email">
            <Input
              id="invite-email"
              name="email"
              type="email"
              required
              autoComplete="off"
              placeholder="name@example.com"
            />
          </Field>
          <Button type="submit">{SETTINGS_ACTIONS.invite}</Button>
        </form>
        {invitations.length === 0 ? (
          <Hint>
            Nobody is invited. Only allowed domains and the administrators’ emails are admitted on a
            provider where anyone can open an account.
          </Hint>
        ) : (
          <DataTable
            caption="Invited addresses"
            columns={invitationColumns}
            rows={invitations}
            rowKey={(invitation) => invitation.email}
            actions={(invitation) => (
              <>
                {local && !invitation.signedIn && (
                  <form method="post" action={`${USERS_PAGE}/local-link`} className={styles.inline}>
                    <input type="hidden" name="kind" value="invite" />
                    <input type="hidden" name="email" value={invitation.email} />
                    <Button type="submit" size="sm" variant="ghost">
                      {sendsMail ? 'Send the account link again' : 'Account link'}
                    </Button>
                  </form>
                )}
                <ConfirmSubmit
                  action={`${USERS_PAGE}/invitations/remove`}
                  fields={{ email: invitation.email }}
                  label={SETTINGS_ACTIONS.remove}
                  ariaLabel={`Remove the invitation of ${invitation.email}`}
                  variant="danger"
                  tone="danger"
                  title={`Remove the invitation of ${invitation.email}?`}
                  consequence={
                    <>
                      Their next sign-in is refused unless an allowed domain of the provider admits
                      them. A session already open runs to its end, at most 8 hours; their account,
                      missions and keys stay. To stop them at once, deactivate them above.
                    </>
                  }
                  confirmLabel={SETTINGS_ACTIONS.remove}
                  testId={`remove-invitation-${invitation.email}`}
                />
              </>
            )}
            testId="invitation-list"
          />
        )}
      </Section>
    </>
  );
}
