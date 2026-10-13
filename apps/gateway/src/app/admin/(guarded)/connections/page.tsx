/**
 * `/admin/connections` — the connections that have no owner left (spec §2.3):
 * their owner group emptied. They keep serving their missions, but nobody can
 * share or reconnect them until the operator names a new owner here. This is
 * the operator's only act on the domain: nothing else of a connection — its
 * credential, its shares, its missions — is reachable from Administration.
 */
import styles from '@/components/connections/connections.module.css';
import { NoticeBanner, AccountState } from '@/components/connections/parts';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Field,
  Input,
  Select,
  Slug,
  Stack,
} from '@/components/ui';
import { requireOperator } from '@/lib/auth/session';
import { takeNotice, type PageSearchParams } from '@/lib/connections/session';
import { OWNERLESS_CONNECTIONS_PAGE, type ConnectionView } from '@/server/connections';

export const dynamic = 'force-dynamic';

export default async function OwnerlessConnectionsPage({
  searchParams,
}: {
  searchParams: PageSearchParams;
}) {
  const { root, principal } = await requireOperator();
  const params = await searchParams;
  const notice = await takeNotice(root, principal.sessionId, params);
  const ownerless = await root.connections.service.listOwnerless();
  // The groups `reassign` accepts, as the service states them.
  const groups = await root.connections.service.reassignTargets();

  return (
    <Stack gap="var(--space-6)">
      <div>
        <h1>Connections without owner</h1>
        <p className={styles.muted}>
          A connection whose owner group has no member left. Its missions keep running, but nobody
          can share it or reconnect it. Name a new owner: a user, or a group that has members.
        </p>
      </div>

      <NoticeBanner notice={notice} />

      {ownerless.length === 0 && (
        <Card>
          <div className={styles.empty}>Every connection has an owner.</div>
        </Card>
      )}

      {ownerless.map((view) => (
        <OwnerlessCard key={view.connection.id} view={view} groups={groups} />
      ))}
    </Stack>
  );
}

function OwnerlessCard({
  view,
  groups,
}: {
  view: ConnectionView;
  groups: readonly { id: string; name: string }[];
}) {
  const { connection } = view;
  const id = `reassign-${connection.id}`;
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <Slug kind="connection" mono={false}>
            {connection.displayName}
          </Slug>
        </CardTitle>
        <span className={styles.badges}>
          <span>{view.providerLabel}</span>
          <AccountState status={connection.status} />
          <span className={styles.muted}>was owned by {view.ownerLabel}</span>
        </span>
      </CardHeader>
      <CardBody>
        <form
          method="post"
          action={`${OWNERLESS_CONNECTIONS_PAGE}/${encodeURIComponent(connection.id)}/reassign`}
        >
          <Stack gap="var(--space-3)">
            <Field label="New owner" htmlFor={`${id}-kind`}>
              <Select id={`${id}-kind`} name="owner_kind" defaultValue="user">
                <option value="user">A user (fill the email)</option>
                <option value="group" disabled={groups.length === 0}>
                  A group (pick it below)
                </option>
              </Select>
            </Field>
            <Field
              label="User email"
              htmlFor={`${id}-email`}
              hint="Used when the new owner is a user. They must have signed in once."
            >
              <Input
                id={`${id}-email`}
                name="owner_email"
                type="email"
                autoComplete="off"
                placeholder="owner@example.com"
              />
            </Field>
            {groups.length > 0 && (
              <Field
                label="Group"
                htmlFor={`${id}-group`}
                hint="Used when the new owner is a group. Only groups that have members are listed."
              >
                <Select id={`${id}-group`} name="owner_group">
                  {groups.map((group) => (
                    <option key={group.id} value={group.id}>
                      {group.name}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            <div>
              <Button type="submit" size="sm">
                Reassign
              </Button>
            </div>
          </Stack>
        </form>
      </CardBody>
    </Card>
  );
}
