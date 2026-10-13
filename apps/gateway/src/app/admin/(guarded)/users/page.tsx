/**
 * `/admin/users` — the users of the instance, and the operator's
 * deactivation of one (spec §2.3 "creator removed from the IdP"; ADR
 * operator-deactivates-a-user). The instance stores no directory: a user is
 * listed once they have signed in. Deactivating is offboarding without the
 * identity provider: no sign-in, no session, no authority, delegations
 * revoked; the user's missions read `orphaned`.
 */
import { LocalDate } from '@/components/LocalDate';
import styles from '@/components/connections/connections.module.css';
import { NoticeBanner } from '@/components/connections/parts';
import { Badge, Button, Card, CardBody, CardHeader, CardTitle, Stack } from '@/components/ui';
import { requireOperator } from '@/lib/auth/session';
import { takeNotice, type PageSearchParams } from '@/lib/connections/session';
import { USERS_PAGE, type UserView } from '@/server/users';

export const dynamic = 'force-dynamic';

export default async function UsersPage({ searchParams }: { searchParams: PageSearchParams }) {
  const { root, principal } = await requireOperator();
  const params = await searchParams;
  const notice = await takeNotice(root, principal.sessionId, params);
  const users = await root.users.service.list();
  const self = principal.kind === 'user' ? principal.user.id : null;

  return (
    <Stack gap="var(--space-6)">
      <div>
        <h1>Users</h1>
        <p className={styles.muted}>
          Everyone who has signed in to this instance. The identity provider decides who may sign
          in; deactivating a user here takes effect at once and does not wait for it: they can no
          longer sign in, their open sessions end, the applications they authorized lose their
          access, they leave every group, and their missions are refused every call (they read
          orphaned). Connections they were the last owner of are listed under Connections, for you
          to reassign.
        </p>
      </div>

      <NoticeBanner notice={notice} />

      {users.length === 0 ? (
        <p className={styles.muted}>Nobody has signed in yet.</p>
      ) : (
        users.map((view) => (
          <UserCard key={view.user.id} view={view} isSelf={view.user.id === self} />
        ))
      )}
    </Stack>
  );
}

function UserCard({ view, isSelf }: { view: UserView; isSelf: boolean }) {
  const { user, groups } = view;
  const active = user.status === 'active';
  const base = `${USERS_PAGE}/${encodeURIComponent(user.id)}`;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{user.email}</CardTitle>
        <span className={styles.badges}>
          <Badge tone={active ? 'success' : 'danger'}>{active ? 'active' : 'deactivated'}</Badge>
          {isSelf && <Badge tone="info">you</Badge>}
        </span>
      </CardHeader>
      <CardBody>
        <Stack gap="var(--space-3)">
          <p className={styles.muted}>
            {user.displayName ? `${user.displayName} — ` : ''}
            last sign-in {user.lastLoginAt ? <LocalDate ts={user.lastLoginAt} /> : 'never'}
            {groups.length > 0 && <> — groups: {groups.join(', ')}</>}
            {!active && user.removedAt && (
              <>
                {' '}
                — deactivated <LocalDate ts={user.removedAt} />
              </>
            )}
          </p>
          {active ? (
            isSelf ? (
              <p className={styles.muted}>
                You cannot deactivate your own account; another operator can.
              </p>
            ) : (
              <form method="post" action={`${base}/deactivate`} className={styles.actions}>
                <Button
                  type="submit"
                  variant="danger"
                  size="sm"
                  aria-label={`Deactivate ${user.email}`}
                >
                  Deactivate
                </Button>
              </form>
            )
          ) : (
            <form method="post" action={`${base}/reactivate`} className={styles.actions}>
              <Button
                type="submit"
                variant="secondary"
                size="sm"
                aria-label={`Reactivate ${user.email}`}
              >
                Reactivate
              </Button>
              <span className={styles.muted}>
                They may sign in again. Groups from the identity provider return at that sign-in;
                local groups, delegations and reassigned connections do not come back by themselves.
              </span>
            </form>
          )}
        </Stack>
      </CardBody>
    </Card>
  );
}
