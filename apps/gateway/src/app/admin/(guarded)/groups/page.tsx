/**
 * `/admin/groups` — Teams (spec §4.2 "Administration", §0 "Group", §11.2). A
 * team owns accounts or receives an access. Teams the identity provider sends
 * are filled at each sign-in and are read-only here; local teams are kept by
 * the administrator, for an identity provider that sends none. A person's
 * teams are both kinds together.
 *
 * A local team shows its members, the form that adds one and the button that
 * removes one; `?team=<id>` opens the members of a team of the identity
 * provider.
 */
import Link from 'next/link';

import styles from '@/components/settings/settings.module.css';
import { NoticeBanner } from '@/components/accounts/parts';
import {
  Avatar,
  Button,
  ConfirmSubmit,
  DataTable,
  Disclosure,
  Field,
  Hint,
  Input,
  PageHeader,
  Section,
  StatusMark,
  type Column,
} from '@/components/ui';
import { requireOperator } from '@/lib/auth/session';
import { firstParam, takeNotice, type PageSearchParams } from '@/lib/accounts/session';
import {
  DOC_PAGES,
  count,
  formatNumber,
  SETTINGS_ACTIONS,
  SETTINGS_PAGES,
  TERMS,
} from '@/lib/vocabulary';
import { GROUP_NAME_MAX_LENGTH, GROUPS_PAGE, type GroupView } from '@/server/groups';

export const dynamic = 'force-dynamic';

/** The query parameter that opens one team. */
const TEAM_PARAM = 'team';
/** Names printed in the row before "and n more". */
const NAMES_SHOWN = 3;

function memberNames(view: GroupView): string {
  const names = view.members.map((member) => member.displayName ?? member.email);
  if (names.length <= NAMES_SHOWN) return names.join(', ');
  return `${names.slice(0, NAMES_SHOWN).join(', ')} and ${formatNumber(names.length - NAMES_SHOWN)} more`;
}

function TeamDetail({ view }: { view: GroupView }) {
  const { group, members } = view;
  const local = group.source === 'local';
  const base = `${GROUPS_PAGE}/${encodeURIComponent(group.id)}/members`;
  return (
    <div className={styles.detail} data-testid={`team-${group.id}`} data-team={group.name}>
      {members.length === 0 ? (
        <p className={styles.quiet}>Nobody is in this team.</p>
      ) : (
        <ul className={styles.members} aria-label={`People of ${group.name}`}>
          {members.map((member) => (
            <li key={member.id} className={styles.member}>
              <span className={styles.inline}>
                <Avatar name={member.displayName ?? member.email} size="xs" />
                {member.email}
              </span>
              {local && (
                <ConfirmSubmit
                  action={`${base}/${encodeURIComponent(member.id)}/remove`}
                  label={SETTINGS_ACTIONS.remove}
                  ariaLabel={`Remove ${member.email} from ${group.name}`}
                  variant="ghost"
                  tone="danger"
                  title={`Remove ${member.email} from ${group.name}?`}
                  consequence={
                    <>
                      They lose what the team gives them, at once: the accounts it owns and the
                      accesses it received. Their missions that depended on it stop, with the reason
                      in every refusal. If they were the last member, the accounts the team owns
                      have no owner left.
                    </>
                  }
                  confirmLabel="Remove from the team"
                />
              )}
            </li>
          ))}
        </ul>
      )}
      {local ? (
        <form method="post" action={base} className={styles.lineForm}>
          <Field
            label="Add someone"
            shape="the email they sign in with"
            htmlFor={`add-member-${group.id}`}
          >
            <Input
              id={`add-member-${group.id}`}
              name="email"
              type="email"
              required
              placeholder="colleague@example.com"
              autoComplete="off"
            />
          </Field>
          <Button type="submit">{SETTINGS_ACTIONS.addMember}</Button>
        </form>
      ) : (
        <p className={styles.quiet}>
          Its members come from the identity provider at each sign-in; they are not edited here.
        </p>
      )}
    </div>
  );
}

export default async function TeamsPage({ searchParams }: { searchParams: PageSearchParams }) {
  const { root, principal } = await requireOperator();
  const params = await searchParams;
  const notice = await takeNotice(root, principal.sessionId, params);
  const groups = await root.groups.service.list();
  // Local teams first: they are the ones an administrator keeps by hand.
  const ordered = [
    ...groups.filter((view) => view.group.source === 'local'),
    ...groups.filter((view) => view.group.source !== 'local'),
  ];
  const opened = firstParam(params[TEAM_PARAM]);

  const columns: readonly Column<GroupView>[] = [
    {
      id: 'team',
      header: 'Team',
      cell: (view) => {
        const open = opened === view.group.id;
        const query = open ? '' : `?${TEAM_PARAM}=${encodeURIComponent(view.group.id)}`;
        return (
          <span className={styles.named}>
            <Avatar name={view.group.name} kind="team" />
            {view.group.source === 'local' ? (
              <span className={styles.name}>{view.group.name}</span>
            ) : (
              <Link
                href={`${GROUPS_PAGE}${query}`}
                scroll={false}
                aria-expanded={open}
                className={styles.name}
                data-testid={`team-link-${view.group.name}`}
              >
                {view.group.name}
              </Link>
            )}
          </span>
        );
      },
    },
    {
      id: 'kind',
      header: 'Kept by',
      nowrap: true,
      cell: (view) => (
        <span className={styles.quiet}>
          {view.group.source === 'local' ? 'you, here' : 'the identity provider'}
        </span>
      ),
    },
    {
      id: 'members',
      header: 'People',
      cell: (view) =>
        view.members.length === 0 ? (
          view.ownedAccounts > 0 ? (
            <StatusMark tone="warn">Nobody left</StatusMark>
          ) : (
            <span className={styles.quiet}>nobody</span>
          )
        ) : (
          <>
            {formatNumber(view.members.length)}{' '}
            <span className={styles.quiet}>· {memberNames(view)}</span>
          </>
        ),
    },
    {
      id: 'owns',
      header: 'Owns',
      nowrap: true,
      cell: (view) =>
        view.ownedAccounts === 0 ? (
          <span className={styles.quiet}>—</span>
        ) : (
          count(view.ownedAccounts, TERMS.account)
        ),
    },
  ];

  return (
    <>
      <PageHeader
        doc={DOC_PAGES.teams}
        title={SETTINGS_PAGES.teams.title}
        lede={SETTINGS_PAGES.teams.lede}
      />
      <NoticeBanner notice={notice} />
      <Section first>
        <DataTable
          caption="The teams of this gateway"
          columns={columns}
          rows={ordered}
          rowKey={(view) => view.group.id}
          // A local team is kept here: its members and its form are always in view.
          rowDetail={(view) =>
            view.group.source === 'local' || opened === view.group.id ? (
              <TeamDetail view={view} />
            ) : null
          }
          empty={<Hint>No team yet.</Hint>}
          testId="teams"
        />
        <Hint>
          When the identity provider sends teams they appear here by themselves and follow each
          sign-in. A local team is for an identity provider that sends none: you keep its members
          here, and a sign-in never changes them.
        </Hint>
      </Section>
      <Section>
        <Disclosure
          id="settings:new-team"
          show={SETTINGS_ACTIONS.addTeam}
          hide="Hide the new team form"
          remember={false}
          testId="new-team"
        >
          <form method="post" action={`${GROUPS_PAGE}/create`} className={styles.lineForm}>
            <Field label="Name of the new team" htmlFor="new-team-name">
              <Input
                id="new-team-name"
                name="name"
                required
                maxLength={GROUP_NAME_MAX_LENGTH}
                placeholder="github-admins"
                autoComplete="off"
              />
            </Field>
            <Button type="submit">Create</Button>
          </form>
        </Disclosure>
      </Section>
    </>
  );
}
