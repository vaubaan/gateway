/**
 * The accounts whose owners all left (spec §2.3), as the last region of the
 * Accounts page for an administrator. They keep serving their missions, but
 * nobody can give access to them or reconnect them until an administrator
 * names a new owner here: the administrator's only act on an account. Nothing
 * else of it — its credential, who has access, its missions — is reachable.
 *
 * Shown only when at least one account has no owner: a page shows the
 * exception and not the rule. The setup checklist leads here by its anchor.
 */
import shared from '@/components/accounts/account.styles';
import { AccountState } from '@/components/accounts/parts';
import styles from '@/components/settings/settings.styles';
import {
  Button,
  DataTable,
  Field,
  Hint,
  Input,
  Section,
  Select,
  ServiceMark,
  type Column,
} from '@/components/ui';
import { holderWords, SETTINGS_ACTIONS, SETTINGS_PAGES } from '@/lib/vocabulary';
import { REASSIGN_PATH, type AccountView } from '@/server/accounts';

/** The anchor of the region; `OWNERLESS_ACCOUNTS_PAGE` points at it. */
export const OWNERLESS_ANCHOR = 'without-owner';

export interface OwnerTeam {
  readonly id: string;
  readonly name: string;
}

function OwnerForm({ view, teams }: { view: AccountView; teams: readonly OwnerTeam[] }) {
  const { account } = view;
  const id = `reassign-${account.id}`;
  return (
    <form method="post" action={REASSIGN_PATH(account.id)} className={styles.form} data-testid={id}>
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

const COLUMNS: readonly Column<AccountView>[] = [
  {
    id: 'account',
    header: 'Account',
    cell: (view) => (
      <span className={shared.named}>
        <ServiceMark name={view.service_label} />
        <span className={shared.namedText}>
          <span className={shared.name}>{view.account.displayName}</span>
          <span className={shared.sub}>{view.service_label}</span>
        </span>
      </span>
    ),
  },
  {
    id: 'owner',
    header: 'Was owned by',
    cell: (view) => holderWords(view.owner_label),
  },
  {
    id: 'state',
    header: 'State',
    nowrap: true,
    cell: (view) => <AccountState status={view.account.status} />,
  },
];

export function OwnerlessAccounts({
  ownerless,
  teams,
}: {
  ownerless: readonly AccountView[];
  /** The teams `reassign` accepts, as the service states them. */
  teams: readonly OwnerTeam[];
}) {
  if (ownerless.length === 0) return null;
  return (
    <Section
      title={SETTINGS_PAGES.ownerless.title}
      count={ownerless.length}
      note={SETTINGS_PAGES.ownerless.lede}
      id={OWNERLESS_ANCHOR}
      testId="ownerless-accounts-section"
    >
      <DataTable
        caption="The accounts that have no owner left"
        columns={COLUMNS}
        rows={ownerless}
        rowKey={(view) => view.account.id}
        rowDetail={(view) => <OwnerForm view={view} teams={teams} />}
        testId="ownerless-accounts"
      />
      <Hint>
        You administer this gateway: name a person, or a team that has members. Nothing else of
        these accounts is reachable from here: not their credential, not who has access, not their
        missions.
      </Hint>
    </Section>
  );
}
