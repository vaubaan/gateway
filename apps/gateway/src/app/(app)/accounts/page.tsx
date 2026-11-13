/**
 * `/accounts` — the accounts a person can use (spec §4.2 "Connections",
 * "Shares received"): the ones they own, alone or through a team, the ones a
 * colleague gave them access to, and the services they can connect.
 *
 * An account is a connection; an access is a share. What was a page of its own
 * ("Shares received") is the second region here: one place answers "which
 * accounts can my missions use, and how far". For an administrator, the
 * accounts whose owners all left are the last region, when there are any
 * (docs/handbook/web-app.md).
 *
 * A disconnected account is never deleted: the activity and the missions that
 * ran on it still name it. It leaves the table of yours for a closed list
 * under it, one click away.
 */
import Link from 'next/link';

import { NeedsUser } from '@/components/auth/NeedsUser';
import styles from '@/components/connections/account.module.css';
import { OwnerlessAccounts } from '@/components/connections/OwnerlessAccounts';
import { AccountState, NoticeBanner } from '@/components/connections/parts';
import { PermissionList } from '@/components/connections/PermissionList';
import { ServicePicker } from '@/components/connections/ServicePicker';
import {
  ButtonLink,
  DataTable,
  Disclosure,
  EmptyState,
  Hint,
  PageHeader,
  Section,
  ServiceMark,
  StatusMark,
  type Column,
} from '@/components/ui';
import {
  currentActor,
  firstParam,
  takeNotice,
  type PageSearchParams,
} from '@/lib/connections/session';
import {
  ACCOUNT_PAGES,
  ACCOUNT_STATES,
  ACCOUNT_WORDS,
  ACTIONS,
  ago,
  besidesOwners,
  count,
  formatNumber,
  holderWords,
  mayAllow,
  ownership,
  PAGES,
  ROUTES,
  SECTIONS,
  shortDate,
  TERMS,
} from '@/lib/vocabulary';
import type { GatewayRoot } from '@/server/compose';
import { connectionPath, type Actor, type ConnectionView } from '@/server/connections';
import type { MissionOnConnection } from '@/server/missions/mission-service';
import { PROVIDERS_PATH } from '@/lib/providers/links';
import { providerCards } from '@/lib/providers/reference';
import type { ReceivedRisk, ReceivedShare } from '@/server/shares';

export const dynamic = 'force-dynamic';

/** The query parameter that unfolds the permissions of one shared account. */
const ACCESS_PARAM = 'access';
const CONNECT_ANCHOR = 'connect';
const SHARED_ANCHOR = 'shared-with-you';

/** One account the person owns, with what the list says about it. */
interface OwnedRow {
  readonly view: ConnectionView;
  readonly ownership: string;
  /** Resources discovery still returns. */
  readonly resources: number;
  /** Among them, the ones that need an environment label and have none. */
  readonly unlabelled: number;
  readonly holders: number;
  readonly teamOwned: boolean;
  readonly missions: readonly MissionOnConnection[];
}

export default async function AccountsPage({ searchParams }: { searchParams: PageSearchParams }) {
  const session = await currentActor();
  if (!session) return <NeedsUser />;
  const { root, principal, actor } = session;
  const params = await searchParams;
  const notice = await takeNotice(root, principal.sessionId, params);
  const now = new Date();

  const [owned, received, providers, mine, ownerless, ownerTeams] = await Promise.all([
    root.connections.service.listFor(actor),
    root.shares.service.received(actor),
    root.connections.service.providers(),
    root.missions.service.list(actor.user),
    // The administrator's only act on an account: name an owner where none is left.
    principal.isOperator ? root.connections.service.listOwnerless() : [],
    principal.isOperator ? root.connections.service.reassignTargets() : [],
  ]);
  const rows = await Promise.all(owned.map((view) => ownedRow(root, actor, view)));
  const yours = rows.filter((row) => row.view.connection.status !== 'revoked');
  const disconnected = rows.filter((row) => row.view.connection.status === 'revoked');
  const totals = new Map(
    providerCards(root.registry).map((card) => [card.id, card.counts.risk_ids] as const),
  );
  const shared = sharedRows(
    received,
    totals,
    (connectionId) =>
      mine.filter(
        (overview) =>
          overview.role === 'creator' &&
          overview.state.kind === 'active' &&
          overview.mission.connections.some((c) => c.connectionId === connectionId),
      ).length,
  );
  const unfolded = firstParam(params[ACCESS_PARAM]);
  const stopped = shared.filter((row) => row.connection.status !== 'active');

  const yourColumns: readonly Column<OwnedRow>[] = [
    {
      id: 'account',
      header: ACCOUNT_WORDS.account,
      cell: ({ view, ownership: owns }) => (
        <span className={styles.named}>
          <ServiceMark name={view.provider_label} icon={view.provider_icon} />
          <span className={styles.namedText}>
            <Link href={connectionPath(view.connection.id)} className={styles.name}>
              {view.connection.displayName}
            </Link>
            <span className={styles.sub}>
              {view.provider_label} · {owns}
            </span>
          </span>
        </span>
      ),
    },
    {
      id: 'resources',
      header: ACCOUNT_WORDS.resources,
      cell: (row) =>
        row.resources === 0 ? (
          <span className={styles.quiet}>none found</span>
        ) : (
          <Fact
            value={count(row.resources, TERMS.resource)}
            note={
              row.unlabelled > 0
                ? `${formatNumber(row.unlabelled)} ${ACCOUNT_WORDS.noLabel}`
                : undefined
            }
          />
        ),
    },
    {
      id: 'access',
      header: SECTIONS.whoHasAccess,
      nowrap: true,
      cell: (row) =>
        row.teamOwned ? (
          besidesOwners(row.holders)
        ) : row.holders === 0 ? (
          <span className={styles.quiet}>only you</span>
        ) : (
          `${formatNumber(row.holders)} besides you`
        ),
    },
    {
      id: 'missions',
      header: ACCOUNT_WORDS.missions,
      cell: (row) => missionsFact(row.missions),
    },
    {
      id: 'checked',
      header: ACCOUNT_WORDS.lastChecked,
      align: 'right',
      nowrap: true,
      cell: (row) => lastChecked(row.view, now),
    },
  ];

  // A disconnected account reaches nothing and runs nothing: its name and when it ended.
  const disconnectedColumns: readonly Column<OwnedRow>[] = [
    yourColumns[0]!,
    {
      id: 'checked',
      header: ACCOUNT_WORDS.status,
      align: 'right',
      nowrap: true,
      cell: (row) => <AccountState status={row.view.connection.status} />,
    },
  ];

  const sharedColumns: readonly Column<SharedRow>[] = [
    {
      id: 'account',
      header: ACCOUNT_WORDS.account,
      cell: (row) => (
        <span className={styles.named}>
          <ServiceMark name={row.providerLabel} icon={row.providerIcon} />
          <span className={styles.namedText}>
            <span className={styles.name}>{row.connection.displayName}</span>
            <span className={styles.sub}>{row.providerLabel}</span>
          </span>
        </span>
      ),
    },
    {
      id: 'allow',
      header: ACCOUNT_WORDS.youMayAllow,
      nowrap: true,
      cell: (row) => {
        const open = unfolded === row.connection.id;
        const query = open ? '' : `?${ACCESS_PARAM}=${encodeURIComponent(row.connection.id)}`;
        return (
          <Link
            href={`${ROUTES.accounts}${query}#${SHARED_ANCHOR}`}
            scroll={false}
            aria-expanded={open}
            className={styles.reveal}
            data-testid={`allowed-${row.connection.id}`}
          >
            {mayAllow(row.permissions.length, row.total)}
          </Link>
        );
      },
    },
    {
      id: 'given',
      header: ACCOUNT_WORDS.givenBy,
      cell: (row) => (
        <Fact
          value={row.givenBy}
          note={[shortDate(row.since, now), ...row.through.map((team) => `through ${team}`)].join(
            ' · ',
          )}
        />
      ),
    },
    {
      id: 'missions',
      header: ACCOUNT_WORDS.missions,
      cell: (row) => formatNumber(row.missions),
    },
    {
      id: 'status',
      header: ACCOUNT_WORDS.status,
      align: 'right',
      nowrap: true,
      cell: (row) => <AccountState status={row.connection.status} />,
    },
  ];

  return (
    <>
      <PageHeader
        title={PAGES.accounts.title}
        lede={PAGES.accounts.lede}
        primary={
          <ButtonLink href={`#${CONNECT_ANCHOR}`} variant="primary" external>
            {ACTIONS.connectAccount}
          </ButtonLink>
        }
      />
      <NoticeBanner notice={notice} />

      {rows.length === 0 && shared.length === 0 ? (
        <EmptyState title={ACCOUNT_PAGES.empty} testId="accounts-empty" />
      ) : (
        <Section
          title={SECTIONS.yours}
          count={yours.length}
          note={ACCOUNT_PAGES.yours}
          id="yours"
          first
        >
          <DataTable
            caption="The accounts you own"
            columns={yourColumns}
            rows={yours}
            rowKey={(row) => row.view.connection.id}
            empty={
              <Hint>
                {disconnected.length === 0
                  ? 'You own no account yet. Connect one below.'
                  : 'None of your accounts is connected. Connect one below.'}
              </Hint>
            }
            testId="accounts-yours"
          />
          {disconnected.length > 0 && (
            <Disclosure
              id="accounts:disconnected"
              show={`Show the ${count(disconnected.length, TERMS.disconnectedAccount)}`}
              hide="Hide the disconnected ones"
              testId="accounts-disconnected"
            >
              <DataTable
                caption="Your disconnected accounts"
                columns={disconnectedColumns}
                rows={disconnected}
                rowKey={(row) => row.view.connection.id}
                rowTone={() => 'quiet'}
              />
            </Disclosure>
          )}
        </Section>
      )}

      {shared.length > 0 && (
        <Section
          title={SECTIONS.sharedWithYou}
          count={shared.length}
          note={ACCOUNT_PAGES.shared}
          id={SHARED_ANCHOR}
          testId="shared-with-you"
        >
          <DataTable
            caption="The accounts a colleague gave you access to"
            columns={sharedColumns}
            rows={shared}
            rowKey={(row) => row.connection.id}
            rowDetail={(row) =>
              unfolded === row.connection.id ? (
                <PermissionList
                  testId="allowed-permissions"
                  head={`What you may allow in your missions on ${row.connection.displayName}, and nothing beyond.`}
                  permissions={row.permissions.map((risk) => ({
                    id: risk.risk_id,
                    label: risk.label,
                    row: risk.row,
                    known: risk.known,
                  }))}
                />
              ) : null
            }
          />
          {stopped.length > 0 && (
            <Hint>
              {stopped.map((row) => row.connection.displayName).join(', ')}{' '}
              {stopped.length === 1 ? 'does' : 'do'} not answer any more; only an owner can
              reconnect {stopped.length === 1 ? 'it' : 'them'}. Your missions on{' '}
              {stopped.length === 1 ? 'it' : 'them'} are refused meanwhile.
            </Hint>
          )}
        </Section>
      )}

      <Section
        title={ACCOUNT_PAGES.connect.title}
        note={ACCOUNT_PAGES.connect.lede}
        id={CONNECT_ANCHOR}
      >
        <ServicePicker providers={providers} />
        <Hint>
          What an agent can then do on each service, permission by permission, is in the{' '}
          <Link href={PROVIDERS_PATH}>{PAGES.reference.title}</Link>.
        </Hint>
      </Section>

      {principal.isOperator && <OwnerlessAccounts ownerless={ownerless} teams={ownerTeams} />}
    </>
  );
}

async function ownedRow(root: GatewayRoot, actor: Actor, view: ConnectionView): Promise<OwnedRow> {
  const { connection } = view;
  const [detail, context, missions] = await Promise.all([
    root.connections.service.get(actor, connection.id),
    root.shares.service.contextFor(actor, connection.id),
    root.missions.service.onConnection(actor.user, connection.id),
  ]);
  const team =
    connection.owner.kind === 'group'
      ? actor.groups.find((group) => group.id === connection.owner.id)?.name
      : undefined;
  // A label matters only where a permission depends on one and the plugin does not read it from the call.
  const needsLabels =
    !context.labelling.derivesEnv && context.risks.some((risk) => risk.env !== null);
  return {
    view,
    ownership: ownership({ you: true, team }),
    resources: detail.resources.filter((resource) => resource.staleSince === null).length,
    unlabelled: needsLabels ? context.labelling.unlabelledResources : 0,
    holders: context.shares.length,
    teamOwned: connection.owner.kind === 'group',
    missions,
  };
}

/** One account shared with the person: every access to it added up. */
interface SharedRow {
  readonly connection: ReceivedShare['connection'];
  readonly providerLabel: string;
  readonly providerIcon: ReceivedShare['providerIcon'];
  readonly givenBy: string;
  /** Through which teams the access reaches the person; empty when it was given to them. */
  readonly through: readonly string[];
  readonly since: string;
  /** The union of the permissions of every access, each id once. */
  readonly permissions: readonly ReceivedRisk[];
  /** How many explicit permissions the service has in all. */
  readonly total: number;
  /** The person's own missions on this account that still run. */
  readonly missions: number;
}

function sharedRows(
  received: readonly ReceivedShare[],
  totals: ReadonlyMap<string, number>,
  missionsOn: (connectionId: string) => number,
): SharedRow[] {
  const rows = new Map<string, SharedRow>();
  for (const item of received) {
    const known = rows.get(item.connection.id);
    const through = item.via === 'you' ? [] : [holderWords(item.via)];
    if (!known) {
      rows.set(item.connection.id, {
        connection: item.connection,
        providerLabel: item.providerLabel,
        providerIcon: item.providerIcon,
        givenBy: holderWords(item.ownerLabel),
        through,
        since: item.share.createdAt,
        permissions: item.risks,
        total: totals.get(item.connection.provider) ?? item.risks.length,
        missions: missionsOn(item.connection.id),
      });
      continue;
    }
    const held = new Set(known.permissions.map((risk) => risk.risk_id));
    rows.set(item.connection.id, {
      ...known,
      through: [...new Set([...known.through, ...through])],
      since: item.share.createdAt < known.since ? item.share.createdAt : known.since,
      permissions: [...known.permissions, ...item.risks.filter((risk) => !held.has(risk.risk_id))],
    });
  }
  return [...rows.values()];
}

function Fact({ value, note }: { value: React.ReactNode; note?: React.ReactNode }) {
  return (
    <span className={styles.fact}>
      {value}
      {note && <span className={styles.factNote}>{note}</span>}
    </span>
  );
}

function missionsFact(missions: readonly MissionOnConnection[]): React.ReactNode {
  const running = missions.filter((mission) => mission.state === 'active');
  const atLimit = running.filter((mission) => mission.exhausted > 0).length;
  const orphaned = missions.filter((mission) => mission.state === 'orphaned').length;
  const notes = [
    atLimit > 0 ? `${formatNumber(atLimit)} at its limit` : null,
    orphaned > 0 ? `${formatNumber(orphaned)} stopped` : null,
  ].filter(Boolean);
  return <Fact value={formatNumber(running.length)} note={notes.join(' · ') || undefined} />;
}

function lastChecked({ connection, discovery }: ConnectionView, now: Date): React.ReactNode {
  if (ACCOUNT_STATES[connection.status].tone !== null || connection.status === 'revoked') {
    return <AccountState status={connection.status} />;
  }
  if (!discovery) return <span className={styles.quiet}>{ACCOUNT_WORDS.neverChecked}</span>;
  if (!discovery.ok) return <StatusMark tone="warn">{ACCOUNT_WORDS.checkFailed}</StatusMark>;
  return <span className={styles.quiet}>{ago(discovery.at, now)}</span>;
}
