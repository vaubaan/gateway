/**
 * `/admin/users` — People: everyone who signed in, and the administrator's
 * deactivation of one (spec §2.3 "creator removed from the IdP"; ADR
 * operator-deactivates-a-user). The gateway stores no directory: a person is
 * listed once they have signed in. Deactivating is offboarding without the
 * identity provider: no sign-in, no session, no key, connected apps
 * disconnected; their missions stop for want of an owner. The act is asked
 * first, with what it stops.
 */
import styles from '@/components/settings/settings.module.css';
import { NoticeBanner } from '@/components/connections/parts';
import {
  Avatar,
  Button,
  ConfirmSubmit,
  DataTable,
  EmptyState,
  Hint,
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
import { USERS_PAGE, type UserView } from '@/server/users';

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
  const users = await root.users.service.list();
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
          active &&
          isOperator({ email: view.user.email, groupNames: view.groups }, root.config.admin);
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
                      created stop — every call is refused — and an account they were the last owner
                      of is listed under “{SETTINGS_PAGES.ownerless.title}”, for you to name a new
                      owner.
                    </>
                  }
                  confirmLabel={SETTINGS_ACTIONS.deactivate}
                  hint="You can reactivate them later; their missions then run again."
                  testId={`deactivate-${view.user.id}`}
                />
              );
            }}
            testId="people"
          />
        )}
        <Hint>
          The identity provider decides who may sign in; a person appears here once they have. You
          cannot deactivate yourself: another administrator can.
        </Hint>
      </Section>
    </>
  );
}
