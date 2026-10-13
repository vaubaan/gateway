/**
 * `/admin/connections` — Accounts without owner (spec §2.3): the accounts
 * whose owners all left. They keep serving their missions, but nobody can
 * give access to them or reconnect them until an administrator names a new
 * owner here. This is the administrator's only act on an account: nothing
 * else of it — its credential, who has access, its missions — is reachable
 * from the administration.
 */
import shared from '@/components/connections/account.module.css';
import { AccountState, NoticeBanner } from '@/components/connections/parts';
import styles from '@/components/settings/settings.module.css';
import {
  Button,
  DataTable,
  EmptyState,
  Field,
  Hint,
  Input,
  PageHeader,
  Section,
  Select,
  ServiceMark,
  type Column,
} from '@/components/ui';
import { requireOperator } from '@/lib/auth/session';
import { takeNotice, type PageSearchParams } from '@/lib/connections/session';
import { holderWords, SETTINGS_ACTIONS, SETTINGS_PAGES } from '@/lib/vocabulary';
import { OWNERLESS_CONNECTIONS_PAGE, type ConnectionView } from '@/server/connections';

export const dynamic = 'force-dynamic';

function OwnerForm({
  view,
  teams,
}: {
  view: ConnectionView;
  teams: readonly { id: string; name: string }[];
}) {
  const { connection } = view;
  const id = `reassign-${connection.id}`;
  return (
    <form
      method="post"
      action={`${OWNERLESS_CONNECTIONS_PAGE}/${encodeURIComponent(connection.id)}/reassign`}
      className={styles.form}
      data-testid={id}
    >
      <Field label="New owner" htmlFor={`${id}-kind`}>
        <Select id={`${id}-kind`} name="owner_kind" defaultValue="user">
          <option value="user">A person (fill the email)</option>
          <option value="group" disabled={teams.length === 0}>
            A team (pick it below)
          </option>
        </Select>
      </Field>
      <Field
        label="Email"
        shape="when the new owner is a person"
        htmlFor={`${id}-email`}
        hint="They must have signed in once."
      >
        <Input
          id={`${id}-email`}
          name="owner_email"
          type="email"
          autoComplete="off"
          placeholder="owner@example.com"
        />
      </Field>
      {teams.length > 0 && (
        <Field
          label="Team"
          shape="when the new owner is a team"
          htmlFor={`${id}-group`}
          hint="Only teams that have members are listed."
        >
          <Select id={`${id}-group`} name="owner_group">
            {teams.map((team) => (
              <option key={team.id} value={team.id}>
                {team.name}
              </option>
            ))}
          </Select>
        </Field>
      )}
      <div className={styles.formActions}>
        <Button type="submit" variant="primary" size="sm">
          {SETTINGS_ACTIONS.nameOwner}
        </Button>
        <span className={styles.formHint}>
          The new owner holds every permission of the account and decides who else may use it.
        </span>
      </div>
    </form>
  );
}

export default async function OwnerlessAccountsPage({
  searchParams,
}: {
  searchParams: PageSearchParams;
}) {
  const { root, principal } = await requireOperator();
  const params = await searchParams;
  const notice = await takeNotice(root, principal.sessionId, params);
  const ownerless = await root.connections.service.listOwnerless();
  // The teams `reassign` accepts, as the service states them.
  const teams = await root.connections.service.reassignTargets();

  const columns: readonly Column<ConnectionView>[] = [
    {
      id: 'account',
      header: 'Account',
      cell: (view) => (
        <span className={shared.named}>
          <ServiceMark name={view.providerLabel} />
          <span className={shared.namedText}>
            <span className={shared.name}>{view.connection.displayName}</span>
            <span className={shared.sub}>{view.providerLabel}</span>
          </span>
        </span>
      ),
    },
    {
      id: 'owner',
      header: 'Was owned by',
      cell: (view) => holderWords(view.ownerLabel),
    },
    {
      id: 'state',
      header: 'State',
      nowrap: true,
      cell: (view) => <AccountState status={view.connection.status} />,
    },
  ];

  return (
    <>
      <PageHeader title={SETTINGS_PAGES.ownerless.title} lede={SETTINGS_PAGES.ownerless.lede} />
      <NoticeBanner notice={notice} />
      <Section first>
        {ownerless.length === 0 ? (
          <EmptyState title="Every account has an owner." testId="no-ownerless" />
        ) : (
          <>
            <DataTable
              caption="The accounts that have no owner left"
              columns={columns}
              rows={ownerless}
              rowKey={(view) => view.connection.id}
              rowDetail={(view) => <OwnerForm view={view} teams={teams} />}
              testId="ownerless-accounts"
            />
            <Hint>
              Name a person, or a team that has members. Nothing else of an account is reachable
              from here: not its credential, not who has access, not its missions.
            </Hint>
          </>
        )}
      </Section>
    </>
  );
}
