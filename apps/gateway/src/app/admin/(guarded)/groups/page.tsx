/**
 * `/admin/groups` — the groups of the instance (spec §4.2 Administration
 * "local groups", §0 "Group", §11.2). A group owns connections or receives
 * shares. Groups claimed by the identity provider are filled at each sign-in
 * and are read-only here; local groups are kept by the operator, for an IdP
 * that provides none. A user's groups are both kinds together.
 */
import styles from '@/components/connections/connections.module.css';
import { NoticeBanner } from '@/components/connections/parts';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Input,
  Slug,
  Stack,
} from '@/components/ui';
import { requireOperator } from '@/lib/auth/session';
import { takeNotice, type PageSearchParams } from '@/lib/connections/session';
import { GROUP_NAME_MAX_LENGTH, GROUPS_PAGE, type GroupView } from '@/server/groups';

export const dynamic = 'force-dynamic';

export default async function GroupsPage({ searchParams }: { searchParams: PageSearchParams }) {
  const { root, principal } = await requireOperator();
  const params = await searchParams;
  const notice = await takeNotice(root, principal.sessionId, params);
  const groups = await root.groups.service.list();
  const local = groups.filter((view) => view.group.source === 'local');
  const fromIdp = groups.filter((view) => view.group.source === 'idp');

  return (
    <Stack gap="var(--space-6)">
      <div>
        <h1>Groups</h1>
        <p className={styles.muted}>
          A group can own a connection (each member is then a full owner) or receive a share. When
          the identity provider sends groups, they appear here by themselves and follow each
          sign-in. Local groups are for an identity provider that sends none: you keep their members
          here, and a sign-in never changes them.
        </p>
      </div>

      <NoticeBanner notice={notice} />

      <Card>
        <CardHeader>
          <CardTitle>New local group</CardTitle>
        </CardHeader>
        <CardBody>
          <form method="post" action={`${GROUPS_PAGE}/create`} className={styles.actions}>
            <Input
              name="name"
              required
              maxLength={GROUP_NAME_MAX_LENGTH}
              placeholder="github-admins"
              aria-label="Name of the new group"
              autoComplete="off"
            />
            <Button type="submit" size="sm">
              Create
            </Button>
          </form>
        </CardBody>
      </Card>

      {local.map((view) => (
        <GroupCard key={view.group.id} view={view} />
      ))}
      {fromIdp.map((view) => (
        <GroupCard key={view.group.id} view={view} />
      ))}
      {groups.length === 0 && <p className={styles.muted}>No group yet.</p>}
    </Stack>
  );
}

function GroupCard({ view }: { view: GroupView }) {
  const { group, members } = view;
  const local = group.source === 'local';
  const base = `${GROUPS_PAGE}/${encodeURIComponent(group.id)}/members`;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{group.name}</CardTitle>
        <span className={styles.badges}>
          <Badge tone={local ? 'info' : 'neutral'}>{local ? 'local' : 'identity provider'}</Badge>
          {view.ownedConnections > 0 && (
            <span className={styles.muted}>
              owns {view.ownedConnections}{' '}
              {view.ownedConnections === 1 ? 'connection' : 'connections'}
            </span>
          )}
        </span>
      </CardHeader>
      <CardBody>
        <Stack gap="var(--space-3)">
          {members.length === 0 ? (
            <p className={styles.muted}>
              No member.
              {view.ownedConnections > 0 &&
                ' The connections it owns have no owner: reassign them under Connections.'}
            </p>
          ) : (
            <ul aria-label={`Members of ${group.name}`} style={{ margin: 0, paddingLeft: 0 }}>
              {members.map((member) => (
                <li key={member.id} className={styles.actions} style={{ listStyle: 'none' }}>
                  <Slug kind="member" mono={false}>
                    {member.email}
                  </Slug>
                  {local && (
                    <form
                      method="post"
                      action={`${base}/${encodeURIComponent(member.id)}/remove`}
                      className={styles.inlineForm}
                    >
                      <Button
                        type="submit"
                        variant="secondary"
                        size="sm"
                        aria-label={`Remove ${member.email} from ${group.name}`}
                      >
                        Remove
                      </Button>
                    </form>
                  )}
                </li>
              ))}
            </ul>
          )}
          {local ? (
            <form method="post" action={base} className={styles.actions}>
              <Input
                name="email"
                type="email"
                required
                placeholder="colleague@example.com"
                aria-label={`Email to add to ${group.name}`}
                autoComplete="off"
              />
              <Button type="submit" variant="secondary" size="sm">
                Add member
              </Button>
            </form>
          ) : (
            <p className={styles.muted}>
              Members come from the identity provider at each sign-in; they cannot be edited here.
            </p>
          )}
        </Stack>
      </CardBody>
    </Card>
  );
}
