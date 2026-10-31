/**
 * The page of one account, as its owner reads it (spec §0 "Connection",
 * "Resource", "Share"; §4.2; §7.2; §7.3): who has access and up to what, what
 * the account reaches, which missions use it.
 *
 * `loadAccount` gathers what the page shows; `AccountView` draws it. Both are
 * used by `/accounts/<id>` and by `/accounts/<id>/share`, which draws the same
 * page under the "Give access" dialog.
 *
 * A control shown here follows a rule the services state, read from what the
 * page already loads: `ShareContext.unshareable` (no owner act on a
 * disconnected account or one without owner), `transferTargets` (the teams a
 * transfer accepts). The statuses tested below only choose what is displayed.
 */
import Link from 'next/link';

import { CloseOrphanedMission } from '@/components/connections/CloseOrphanedMission';
import shared from '@/components/connections/account.module.css';
import { AccountState, credentialKindLabel, NoticeBanner } from '@/components/connections/parts';
import { PermissionList } from '@/components/connections/PermissionList';
import { RevokeConnection } from '@/components/connections/RevokeConnection';
import { ValidationBadge } from '@/components/telemetry/ValidationBadge';
import {
  Avatar,
  Button,
  ButtonLink,
  Callout,
  Checkbox,
  CodeBlock,
  DataTable,
  DetailOnly,
  DetailScope,
  DetailToggle,
  Disclosure,
  EnvTag,
  Field,
  Hint,
  Input,
  KeyValue,
  Mono,
  PageHeader,
  Row,
  Rows,
  Section,
  Select,
  ServiceMark,
  StatusMark,
  Tag,
  Textarea,
  type Column,
} from '@/components/ui';
import {
  ACCOUNT_ACTIONS,
  ACCOUNT_PAGES,
  ACCOUNT_STATES,
  ACCOUNT_WORDS,
  ACTIONS,
  ago,
  expiresOn,
  capitalize,
  count,
  formatNumber,
  mayAllow,
  MISSION_STATES,
  ORPHAN_WORDS,
  PART_LOSS_WORDS,
  ownedBy,
  PAGES,
  ROUTES,
  SECTIONS,
  shortDate,
  TERMS,
  TOKEN_CONNECT,
  TOKEN_EXPIRY_NOTICE_DAYS,
} from '@/lib/vocabulary';
import type { GatewayRoot } from '@/server/compose';
import {
  connectionPath,
  editableMetadataKeys,
  METADATA_PREFIX,
  NEW_CONNECTION_PATH,
  type Actor,
  type ConnectionDetail,
  type Notice,
} from '@/server/connections';
import { providerGrantForecast, providerGrantReport } from '@/server/connections/provider-grant';
import type { MissionOnConnection } from '@/server/missions/mission-service';
import type { CatalogRisk } from '@/server/missions/model';
import { toolTitleOf } from '@/server/providers/tool-titles';
import { providerPath } from '@/server/providers/links';
import {
  sharePath,
  type ConnectionHolders,
  type HeldShare,
  type HolderView,
  type ShareContext,
} from '@/server/shares';
import type { ConnectionResourceRecord, GroupRecord } from '@/server/store';
import { ownResourceEnv } from '@/server/store/resource-env';
import type { ValidationStatus } from '@/server/telemetry';

import { RemoveAccess, TransferOwnership } from './account-actions';
import styles from '../accounts.module.css';
import { MS_PER_DAY } from '@vaubaan/shared/time';

/** The query parameters that unfold one row of the page. */
export const ACCOUNT_PARAMS = { access: 'access', resource: 'resource' } as const;
const RESOURCES_ANCHOR = 'resources';
const ACCESS_ANCHOR = 'who-has-access';
/** One day, for the token expiry notice. */

/** Resources listed before "All N". */
const RESOURCES_SHOWN = 10;
/** A person who has not signed in for this long is worth a word beside their name. */
const QUIET_SIGN_IN_DAYS = 21;
const ENV_LABEL_HTML_PATTERN = '[a-z][a-z0-9\\-]*';
const MAX_NAME_LENGTH = 80;

export interface AccountData {
  readonly detail: ConnectionDetail;
  readonly context: ShareContext;
  readonly holders: ConnectionHolders;
  readonly missions: readonly MissionOnConnection[];
  /** Empty when the account takes no owner act. */
  readonly transferTargets: readonly GroupRecord[];
  readonly validation: ValidationStatus | null;
  /** Refs of this account's resources that host this instance: never reachable by a mission. */
  readonly selfRefs: ReadonlySet<string>;
  /**
   * The tools of this service that cannot run on this account because it reaches a
   * resource hosting this instance (`ProviderPlugin.unboundTools`), as titles; empty
   * when it reaches none (SEC 2026-10-15 re-check M-1).
   */
  readonly unboundTools: readonly string[];
}

/** Everything the page shows. Throws the services' "not found" for anyone but an owner. */
export async function loadAccount(
  root: GatewayRoot,
  actor: Actor,
  connectionId: string,
): Promise<AccountData> {
  const detail = await root.connections.service.get(actor, connectionId);
  const [context, holders, missions, validation] = await Promise.all([
    root.shares.service.contextFor(actor, connectionId),
    root.shares.service.holders(actor, connectionId),
    root.missions.service.onConnection(actor.user, connectionId),
    root.telemetry.stats.statusFor(detail.connection.provider),
  ]);
  const selfRefs = new Set(
    root.config.selfResources
      .filter((self) => self.provider === detail.connection.provider)
      .map((self) => self.ref),
  );
  return {
    detail,
    context,
    holders,
    missions,
    transferTargets: root.connections.service.transferTargets(actor, detail.connection),
    validation,
    selfRefs,
    unboundTools: detail.resources.some((resource) => selfRefs.has(resource.ref))
      ? Object.keys(root.registry.get(detail.connection.provider)?.plugin.unboundTools ?? {}).map(
          (tool) => toolTitleOf(root.registry, tool) ?? tool,
        )
      : [],
  };
}

// ── Who has access ───────────────────────────────────────────────────────────

/** One line of "Who has access": the owner, or an access given. */
interface AccessRow {
  readonly key: string;
  readonly holder: HolderView;
  readonly share: HeldShare | null;
  /** Running missions on this account written by one of the people behind the row. */
  readonly missions: number;
}

function runningBy(missions: readonly MissionOnConnection[], holder: HolderView): number {
  const people = new Set(holder.people.map((person) => person.id));
  return missions.filter((mission) => mission.state === 'active' && people.has(mission.creator.id))
    .length;
}

function holderNote(holder: HolderView, owner: boolean, now: Date): string {
  const words: string[] = [];
  if (owner) words.push('owner');
  if (holder.kind === 'group') {
    words.push(
      owner
        ? holder.people.map((person) => (person.you ? 'you' : person.name)).join(', ') ||
            'no member left'
        : count(holder.people.length, TERMS.user),
    );
  } else {
    if (holder.you) words.push('you');
    if (holder.inactive) words.push('deactivated');
    else if (
      holder.lastLoginAt &&
      now.getTime() - new Date(holder.lastLoginAt).getTime() > QUIET_SIGN_IN_DAYS * MS_PER_DAY
    ) {
      words.push(`no sign-in since ${shortDate(holder.lastLoginAt, now)}`);
    }
  }
  return words.filter(Boolean).join(' · ');
}

function HolderCell({ row, now }: { row: AccessRow; now: Date }) {
  const { holder } = row;
  const note = holderNote(holder, row.share === null, now);
  return (
    <span className={styles.holder}>
      <Avatar
        name={holder.name}
        kind={holder.kind === 'group' ? 'team' : 'person'}
        muted={holder.inactive}
      />
      <span>
        <span className={styles.holderName} title={holder.email ?? undefined}>
          {holder.kind === 'group' ? `${holder.name} team` : holder.name}
        </span>
        {note && <span className={styles.holderNote}> · {note}</span>}
        {holder.email && holder.email !== holder.name && (
          <DetailOnly>
            <span className={shared.sub}>{holder.email}</span>
          </DetailOnly>
        )}
      </span>
    </span>
  );
}

function readOnly(restriction: readonly string[], catalog: ReadonlyMap<string, CatalogRisk>) {
  return restriction.length > 0 && restriction.every((id) => catalog.get(id)?.kind === 'read');
}

// ── Resources ────────────────────────────────────────────────────────────────

function listOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** The form of one resource, under its row: name, environment, hidden, the plugin's lists. */
function ResourceEditor({
  resource,
  action,
  cancelHref,
}: {
  resource: ConnectionResourceRecord;
  action: string;
  cancelHref: string;
}) {
  const formId = `resource-${resource.id}`;
  const listKeys = editableMetadataKeys(resource.metadata);
  const pluginSetsEnv = resource.envSource === 'plugin';
  return (
    <form method="post" action={action} className={styles.editor} data-testid="resource-editor">
      <input type="hidden" name="hidden_present" value="1" />
      <Field label="Name" shape="how it appears in missions" htmlFor={`${formId}-name`}>
        <Input
          id={`${formId}-name`}
          name="display_name"
          defaultValue={resource.displayName}
          maxLength={MAX_NAME_LENGTH}
        />
      </Field>
      {pluginSetsEnv ? (
        <Field label={ACCOUNT_WORDS.environment} hint="Set by the service; it is not edited here.">
          <span>
            <EnvTag env={resource.env} />
          </span>
        </Field>
      ) : (
        <Field
          label={ACCOUNT_WORDS.environment}
          shape="lower-case letters, digits and dashes"
          optional
          htmlFor={`${formId}-env`}
          hint={
            resource.envSource === 'connection-default'
              ? `Empty: the resource carries the account's default, ${resource.env ?? ''}. A label set here wins over it.`
              : 'A permission tied to an environment is refused on a resource without this label.'
          }
        >
          <Input
            id={`${formId}-env`}
            name="env"
            defaultValue={ownResourceEnv(resource) ?? ''}
            placeholder="prod, staging…"
            pattern={ENV_LABEL_HTML_PATTERN}
            mono
          />
        </Field>
      )}
      {listKeys.map((key) => (
        <div key={key} className={styles.editorWide}>
          <Field
            label={key.replace(/_/g, ' ')}
            htmlFor={`${formId}-${key}`}
            hint="One entry per line, or separated by spaces or commas."
          >
            <Textarea
              id={`${formId}-${key}`}
              name={`${METADATA_PREFIX}${key}`}
              rows={2}
              spellCheck={false}
              defaultValue={listOf(resource.metadata?.[key]).join('\n')}
              mono
            />
          </Field>
        </div>
      ))}
      <div className={styles.editorWide}>
        <Checkbox name="hidden" defaultChecked={resource.hidden}>
          Hide from new missions (the missions that already name it keep it)
        </Checkbox>
      </div>
      <div className={styles.editorActions}>
        <Button type="submit" variant="primary" size="sm">
          {ACCOUNT_ACTIONS.save}
        </Button>
        <ButtonLink href={cancelHref} variant="ghost" size="sm">
          {ACTIONS.cancel}
        </ButtonLink>
      </div>
    </form>
  );
}

/**
 * The owner's default environment for the resources without a label of their own
 * (ADR connect-driver-and-resource-curation): one of the labels the service's
 * permissions know, or none.
 */
function DefaultEnvForm({
  action,
  current,
  choices,
}: {
  action: string;
  current: string | null;
  choices: readonly string[];
}) {
  const id = 'account-default-env';
  return (
    <form method="post" action={action} className={styles.editor} data-testid="default-env-form">
      <Field
        label={ACCOUNT_WORDS.defaultEnvironment}
        htmlFor={id}
        hint="Applies to every resource without a label of its own, including the ones found later. A resource's own label always wins; none keeps them unlabelled, and permissions tied to an environment are refused on them."
      >
        <Select id={id} name="default_env" defaultValue={current ?? ''}>
          <option value="">none</option>
          {choices.map((env) => (
            <option key={env} value={env}>
              {env}
            </option>
          ))}
        </Select>
      </Field>
      <div className={styles.editorActions}>
        <Button type="submit" size="sm">
          {ACCOUNT_ACTIONS.save}
        </Button>
      </div>
    </form>
  );
}

/** A resource's environment, and where it comes from when it is the account's default. */
function ResourceEnv({ resource }: { resource: ConnectionResourceRecord }) {
  return (
    <span>
      <EnvTag env={resource.env} />
      {resource.envSource === 'connection-default' && (
        <span className={shared.factNote}> {ACCOUNT_WORDS.fromDefault}</span>
      )}
    </span>
  );
}

// ── Missions ─────────────────────────────────────────────────────────────────

function missionFacts(
  mission: MissionOnConnection,
  refs: ReadonlyMap<string, string>,
  youId: string,
  now: Date,
): string {
  const reached = mission.resource_ids.flatMap((id) => refs.get(id) ?? []);
  const facts = [
    mission.creator.id === youId ? 'you' : mission.creator.label,
    mission.reaches_later
      ? 'the whole account'
      : reached.length === 0
        ? 'no resource of this account'
        : reached.length <= 2
          ? reached.join(', ')
          : count(reached.length, TERMS.resource),
    `${count(mission.permissions, TERMS.risk)}${mission.asks_first > 0 ? ` · ${formatNumber(mission.asks_first)} ask first` : ''}`,
  ];
  if (mission.state === 'orphaned' && mission.orphan_cause) {
    facts.push(ORPHAN_WORDS[mission.orphan_cause]);
  } else if (mission.part_lost) {
    facts.push(PART_LOSS_WORDS[mission.part_lost]);
  }
  if (mission.state === 'expired' && mission.expires_at) {
    facts.push(`expired ${shortDate(mission.expires_at, now)}`);
  }
  return facts.join(' · ');
}

function MissionRow({
  mission,
  refs,
  youId,
  now,
}: {
  mission: MissionOnConnection;
  refs: ReadonlyMap<string, string>;
  youId: string;
  now: Date;
}) {
  const stopped = mission.state === 'orphaned';
  const ended = mission.state === 'expired' || mission.state === 'revoked';
  // Still running on its other accounts, not on this one.
  const lostHere = !stopped && !ended && mission.part_lost !== null;
  return (
    <Row
      title={mission.name}
      href={mission.readable ? `${ROUTES.missions}/${encodeURIComponent(mission.id)}` : undefined}
      description={missionFacts(mission, refs, youId, now)}
      muted={ended}
      aside={
        stopped ? (
          <StatusMark tone={MISSION_STATES.orphaned.tone}>
            {MISSION_STATES.orphaned.label}
          </StatusMark>
        ) : lostHere ? (
          <StatusMark tone={MISSION_STATES.accountLost.tone}>
            {MISSION_STATES.accountLost.label}
          </StatusMark>
        ) : mission.exhausted > 0 ? (
          <StatusMark tone={MISSION_STATES.limitReached.tone}>
            {MISSION_STATES.limitReached.label}
          </StatusMark>
        ) : undefined
      }
      end={
        stopped ? (
          <CloseOrphanedMission missionId={mission.id} name={mission.name} />
        ) : ended ? (
          MISSION_STATES[mission.state === 'expired' ? 'expired' : 'revoked'].label
        ) : undefined
      }
      testId={stopped ? `orphaned-${mission.id}` : `mission-${mission.id}`}
    />
  );
}

// ── The page ─────────────────────────────────────────────────────────────────

export function AccountView({
  data,
  actor,
  notice,
  unfolded,
  note,
  overlay,
}: {
  data: AccountData;
  actor: Actor;
  notice: Notice | null;
  /** What the query string asks to unfold: the permissions of one access, the form of one resource. */
  unfolded: { readonly access: string | null; readonly resource: string | null };
  /** One more note above the lists (why the dialog did not open). */
  note?: React.ReactNode;
  /** The dialog drawn over the page ("Give access"). */
  overlay?: React.ReactNode;
}) {
  const { detail, context, holders, missions, transferTargets, selfRefs } = data;
  const { connection, resources } = detail;
  const now = new Date();
  const base = connectionPath(connection.id);
  const revoked = connection.status === 'revoked';
  // Give access, reconnect: the rule is the services' (`ownerActRefusal`, spec §2.3).
  const ownerActs = context.unshareable === null;
  const catalog = new Map(context.risks.map((risk) => [risk.risk_id, risk] as const));
  const total = context.risks.length;
  // The missions this account still serves: a disconnection would take it from them.
  const running = missions.filter(
    (mission) => mission.state === 'active' && mission.part_lost === null,
  );
  const live = missions.filter(
    (mission) => mission.state === 'active' || mission.state === 'orphaned',
  );
  const ended = missions.filter(
    (mission) => mission.state === 'expired' || mission.state === 'revoked',
  );
  const refs = new Map(resources.map((resource) => [resource.id, resource.ref] as const));

  // What became of the access granted at the service: kept on the page for as long as the
  // account is listed. The note of the act itself says it once; it is not said twice.
  const grant = revoked
    ? providerGrantReport(
        detail.provider_label,
        connection.providerGrant,
        detail.provider_grant.byHand,
      )
    : null;
  const grantSaid =
    grant !== null && (notice?.lines.some((line) => line.includes(grant.text)) ?? false);

  const accessRows: AccessRow[] = [
    {
      key: 'owner',
      holder: holders.owner,
      share: null,
      missions: runningBy(missions, holders.owner),
    },
    ...holders.shares.map((share) => ({
      key: share.share.id,
      holder: share.holder,
      share,
      missions: runningBy(missions, share.holder),
    })),
  ];

  const accessColumns: readonly Column<AccessRow>[] = [
    {
      id: 'who',
      header: ACCOUNT_WORDS.who,
      cell: (row) => <HolderCell row={row} now={now} />,
    },
    {
      id: 'allow',
      header: ACCOUNT_WORDS.mayAllow,
      nowrap: true,
      cell: (row) => {
        if (!row.share) return `all ${formatNumber(total)}`;
        const { share } = row.share;
        const open = unfolded.access === share.id;
        const query = open ? '' : `?${ACCOUNT_PARAMS.access}=${encodeURIComponent(share.id)}`;
        return (
          <span className={shared.fact}>
            <Link
              href={`${base}${query}#${ACCESS_ANCHOR}`}
              scroll={false}
              aria-expanded={open}
              className={shared.reveal}
              data-testid={`allowed-${share.id}`}
            >
              {mayAllow(share.restriction.length, total)}
            </Link>
            {readOnly(share.restriction, catalog) && (
              <span className={shared.factNote}>read only</span>
            )}
          </span>
        );
      },
    },
    {
      id: 'missions',
      header: ACCOUNT_WORDS.missions,
      cell: (row) => formatNumber(row.missions),
    },
    {
      id: 'given',
      header: ACCOUNT_WORDS.givenBy,
      detail: true,
      cell: (row) => (row.share ? row.share.givenBy : <span className={shared.quiet}>—</span>),
    },
    {
      id: 'since',
      header: ACCOUNT_WORDS.since,
      detail: true,
      nowrap: true,
      cell: (row) => shortDate(row.share ? row.share.share.createdAt : connection.createdAt, now),
    },
  ];

  const reachable = resources.filter(
    (resource) => resource.staleSince === null && !selfRefs.has(resource.ref),
  );
  const showsEnvironment =
    resources.some((resource) => resource.env !== null) ||
    (!context.labelling.derivesEnv && context.risks.some((risk) => risk.env !== null));
  // A mission given the whole account reaches every resource it can, hidden ones excepted.
  const missionsOn = (resource: ConnectionResourceRecord) =>
    running.filter(
      (mission) =>
        mission.resource_ids.includes(resource.id) ||
        (mission.reaches_later && !resource.hidden && reachable.includes(resource)),
    ).length;

  const resourceColumns: readonly Column<ConnectionResourceRecord>[] = [
    {
      id: 'resource',
      header: capitalize(TERMS.resource.one),
      // Takes what the other columns leave: they keep the width of what they hold.
      width: '99%',
      cell: (resource) => (
        <span className={shared.namedText}>
          <span>
            <Mono>{resource.ref}</Mono> {resource.hidden && <Tag>{ACCOUNT_WORDS.hidden}</Tag>}{' '}
            {selfRefs.has(resource.ref) && <Tag tone="warn">{ACCOUNT_WORDS.self}</Tag>}{' '}
            {resource.staleSince && (
              <Tag tone="warn">
                {ACCOUNT_WORDS.gone} since {shortDate(resource.staleSince, now)}
              </Tag>
            )}
          </span>
          {resource.displayName !== resource.ref && (
            <span className={shared.sub}>{resource.displayName}</span>
          )}
        </span>
      ),
    },
    ...(showsEnvironment
      ? [
          {
            id: 'environment',
            header: ACCOUNT_WORDS.environment,
            nowrap: true,
            cell: (resource: ConnectionResourceRecord) => <ResourceEnv resource={resource} />,
          } satisfies Column<ConnectionResourceRecord>,
        ]
      : []),
    {
      id: 'missions',
      header: ACCOUNT_WORDS.missions,
      align: 'right',
      nowrap: true,
      width: '1%',
      cell: (resource) => {
        const n = missionsOn(resource);
        return n === 0 ? <span className={shared.quiet}>no mission</span> : count(n, TERMS.mission);
      },
    },
  ];

  const resourceTable = (rows: readonly ConnectionResourceRecord[], headless: boolean) => (
    <DataTable
      caption={`What ${connection.displayName} reaches`}
      columns={resourceColumns}
      rows={rows}
      rowKey={(resource) => resource.id}
      headless={headless}
      rowTone={(resource) => (resource.staleSince ? 'quiet' : undefined)}
      actions={
        revoked
          ? undefined
          : (resource) => (
              <ButtonLink
                href={`${base}?${ACCOUNT_PARAMS.resource}=${encodeURIComponent(resource.id)}#${RESOURCES_ANCHOR}`}
                size="sm"
                aria-label={`Edit ${resource.ref}`}
              >
                Edit
              </ButtonLink>
            )
      }
      rowDetail={(resource) =>
        !revoked && unfolded.resource === resource.id ? (
          <ResourceEditor
            resource={resource}
            action={`${base}/resources/${encodeURIComponent(resource.id)}`}
            cancelHref={`${base}#${RESOURCES_ANCHOR}`}
          />
        ) : null
      }
    />
  );
  // The resource being edited is always in the part that is shown.
  const editing = resources.findIndex((resource) => resource.id === unfolded.resource);
  const shown = Math.max(RESOURCES_SHOWN, editing + 1);
  const firstResources = resources.slice(0, shown);
  const moreResources = resources.slice(shown);

  const lede = [
    detail.provider_label,
    ownedBy({
      team: holders.owner.kind === 'group',
      name: holders.owner.name,
      you: holders.owner.you,
      people: holders.owner.people,
    }),
    `connected ${shortDate(connection.createdAt, now)}`,
    !revoked && detail.discovery ? `checked ${agoWords(detail.discovery.at, now)}` : null,
    // A pasted token's expiry is said ahead of it, on the first line of the page.
    !revoked && detail.token_expires_at ? expiresOn(detail.token_expires_at, now) : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const tokenExpiresSoon =
    !revoked &&
    connection.status !== 'expired' &&
    detail.token_expires_at !== null &&
    Date.parse(detail.token_expires_at) - now.getTime() <= TOKEN_EXPIRY_NOTICE_DAYS * MS_PER_DAY;

  const details = <DetailToggle key="details" />;
  const reconnect = (
    <ButtonLink
      href={`${NEW_CONNECTION_PATH}/${encodeURIComponent(connection.provider)}?connection=${encodeURIComponent(connection.id)}`}
    >
      {ACCOUNT_ACTIONS.reconnect}
    </ButtonLink>
  );

  return (
    <DetailScope id="account:details">
      <PageHeader
        crumbs={[
          { label: PAGES.accounts.title, href: ROUTES.accounts },
          { label: connection.displayName },
        ]}
        mark={<ServiceMark name={detail.provider_label} icon={detail.provider_icon} size="lg" />}
        title={connection.displayName}
        status={
          ACCOUNT_STATES[connection.status].tone !== null || revoked ? (
            <AccountState status={connection.status} />
          ) : undefined
        }
        lede={lede}
        secondary={ownerActs ? [details, reconnect] : [details]}
        primary={
          ownerActs ? (
            <ButtonLink href={sharePath(connection.id)} variant="primary">
              {ACTIONS.giveAccess}
            </ButtonLink>
          ) : undefined
        }
      />
      <NoticeBanner notice={notice} />

      {(note ||
        connection.status === 'expired' ||
        connection.status === 'unowned' ||
        revoked ||
        tokenExpiresSoon ||
        (detail.discovery && !detail.discovery.ok && !revoked)) && (
        <div className={styles.notes}>
          {note}
          {tokenExpiresSoon && detail.token_expires_at && (
            <Callout
              tone="warn"
              title={TOKEN_CONNECT.expiresSoonTitle(shortDate(detail.token_expires_at, now))}
              testId="token-expires-soon"
            >
              {TOKEN_CONNECT.expiresSoonBody}
            </Callout>
          )}
          {connection.status === 'expired' && (
            <Callout tone="bad" title="This account needs reconnecting" testId="account-expired">
              {detail.provider_label} rejected the stored credential and it could not be renewed.
              Every call of the missions that use this account is refused until an owner reconnects
              it.
            </Callout>
          )}
          {detail.way_retired && !revoked && (
            <Callout
              tone="bad"
              title="This account needs reconnecting"
              testId="account-way-retired"
            >
              It was connected a way {detail.provider_label} no longer offers on this gateway. Every
              call of the missions that use it is refused until an owner reconnects it; reconnecting
              keeps the account, its resources and who has access.
            </Callout>
          )}
          {connection.status === 'unowned' && (
            <Callout tone="warn" title="This account has no owner" testId="account-unowned">
              Nobody can reconnect it or give access to it until an administrator names a new owner.
              The missions that use it keep running meanwhile.
            </Callout>
          )}
          {revoked && grant && !grantSaid && (
            <Callout
              tone={grant.actionNeeded ? 'warn' : 'neutral'}
              title={`Disconnected${connection.revokedAt ? ` on ${shortDate(connection.revokedAt, now)}` : ''}`}
              testId="account-disconnected"
            >
              <p>Its credential is erased; this cannot be undone.</p>
              {!grantSaid && (
                <p data-testid="provider-grant">
                  <strong>{grant.title}.</strong> {grant.text}
                </p>
              )}
            </Callout>
          )}
          {data.unboundTools.length > 0 && !revoked && (
            <Callout
              tone="warn"
              title="This account can reach the project that hosts this gateway"
              testId="account-hosts-instance"
            >
              That project is never a mission resource, and these tools are unavailable on this
              account, because they act beyond one resource: {data.unboundTools.join(', ')}. Prefer
              connecting a separate workspace that does not hold the gateway.
            </Callout>
          )}
          {detail.discovery && !detail.discovery.ok && !revoked && (
            <Callout tone="warn" title="The last check failed" testId="check-failed">
              {detail.discovery.error ?? `${detail.provider_label} gave no reason.`} What was found
              before is kept.
            </Callout>
          )}
        </div>
      )}

      <DetailOnly>
        <div className={styles.facts} data-testid="account-facts">
          <KeyValue
            items={[
              {
                term: capitalize(TERMS.provider.one),
                value: (
                  <>
                    {detail.provider_label} ·{' '}
                    <Link href={providerPath(connection.provider)} className={shared.reveal}>
                      what an agent can do on it
                    </Link>{' '}
                    <ValidationBadge status={data.validation} />
                  </>
                ),
              },
              {
                term: 'Credential',
                value: `${credentialKindLabel(detail.credential_kind, detail.way_retired)} · encrypted at rest, never shown`,
              },
              ...(detail.credential_kind === 'api-key' &&
              (detail.token_account || detail.token_expires_at)
                ? [
                    {
                      term: TOKEN_CONNECT.tokenFacts,
                      value: [
                        detail.token_account ? TOKEN_CONNECT.actsAs(detail.token_account) : null,
                        detail.token_expires_at
                          ? expiresOn(detail.token_expires_at, now)
                          : TOKEN_CONNECT.tokenNoExpiry,
                      ]
                        .filter(Boolean)
                        .join(' · '),
                    },
                  ]
                : []),
              ...(detail.oauth_broker
                ? [
                    {
                      term: 'OAuth broker',
                      value: oauthBrokerFact(detail.oauth_broker),
                    },
                  ]
                : []),
              ...Object.entries(detail.fields).map(([name, value]) => ({
                term: capitalize(name.replace(/_/g, ' ')),
                value: <Mono>{value}</Mono>,
              })),
              {
                term: ACCOUNT_WORDS.lastChecked,
                value: detail.discovery
                  ? `${shortDate(detail.discovery.at, now)} · ${
                      detail.discovery.ok
                        ? `${count(detail.discovery.count, TERMS.resource)} found`
                        : `failed: ${detail.discovery.error ?? 'no reason given'}`
                    }${
                      detail.discovery.afterCall
                        ? ` · ${ACCOUNT_WORDS.afterCallOf} ${detail.discovery.afterCall.tool}`
                        : ''
                    }`
                  : ACCOUNT_WORDS.neverChecked,
              },
            ]}
          />
        </div>
      </DetailOnly>

      {detail.public_key && !revoked && (
        <Section title="Public key to install" first>
          <div className={styles.key}>
            <CodeBlock label="Public key" wrap>
              {detail.public_key}
            </CodeBlock>
          </div>
          <Hint>
            Append this line to <code>~/.ssh/authorized_keys</code> of the login user on the host,
            then use “{ACCOUNT_ACTIONS.refresh}” below to check the access. The private key never
            leaves this gateway.
          </Hint>
        </Section>
      )}

      <Section
        title={SECTIONS.whoHasAccess}
        count={accessRows.length}
        note={`${ACCOUNT_PAGES.whoHasAccess} Owners hold all ${count(total, TERMS.risk)} and can give access.`}
        id={ACCESS_ANCHOR}
        first={!(detail.public_key && !revoked)}
        testId="who-has-access"
      >
        <DataTable
          caption={`Who has access to ${connection.displayName}`}
          columns={accessColumns}
          rows={accessRows}
          rowKey={(row) => row.key}
          actions={(row) => {
            if (!row.share) {
              return transferTargets.length > 0 ? (
                <TransferOwnership
                  action={`${base}/transfer`}
                  account={connection.displayName}
                  teams={transferTargets.map((team) => ({ id: team.id, name: team.name }))}
                />
              ) : null;
            }
            const { share } = row.share;
            const who =
              row.holder.kind === 'group' ? `the ${row.holder.name} team` : row.holder.name;
            return (
              <>
                {ownerActs && (
                  <ButtonLink
                    href={`${sharePath(connection.id)}?share=${encodeURIComponent(share.id)}`}
                    size="sm"
                    aria-label={`Edit the access of ${who}`}
                  >
                    {ACCOUNT_ACTIONS.editAccess}
                  </ButtonLink>
                )}{' '}
                <RemoveAccess
                  action={`${base}/shares/${encodeURIComponent(share.id)}/revoke`}
                  who={who}
                  missions={row.missions}
                />
              </>
            );
          }}
          rowDetail={(row) =>
            row.share && unfolded.access === row.share.share.id ? (
              <PermissionList
                testId="access-permissions"
                head={`What ${row.holder.name} may allow in missions on this account, and nothing beyond.`}
                permissions={row.share.share.restriction.map((id) => {
                  const risk = catalog.get(id);
                  return {
                    id,
                    label: risk?.label ?? id,
                    level: risk?.level ?? null,
                    known: risk !== undefined,
                  };
                })}
              />
            ) : null
          }
          testId="access-table"
        />
      </Section>

      <Section
        title={capitalize(TERMS.resource.many)}
        count={reachable.length}
        id={RESOURCES_ANCHOR}
        note={
          revoked ? (
            'What it reached when it was disconnected.'
          ) : (
            <>
              <span>
                {detail.discovery
                  ? `Found ${agoWords(detail.discovery.at, now)}${
                      detail.discovery.afterCall
                        ? `, ${ACCOUNT_WORDS.afterCallOf} ${detail.discovery.afterCall.tool}`
                        : ''
                    }.`
                  : 'Nothing was looked for yet.'}
              </span>
              <form method="post" action={`${base}/discover`} className={styles.inlineForm}>
                <button type="submit" className={styles.linkButton}>
                  {ACCOUNT_ACTIONS.refresh}
                </button>
              </form>
            </>
          )
        }
        testId="account-resources"
      >
        {!revoked && detail.default_env_choices.length > 0 && (
          <DefaultEnvForm
            action={`${base}/default-env`}
            current={connection.defaultEnv}
            choices={detail.default_env_choices}
          />
        )}
        {resources.length === 0 ? (
          <Hint>
            Nothing found yet.
            {!revoked &&
              ` Use “${ACCOUNT_ACTIONS.refresh}” once ${detail.provider_label} is reachable.`}
          </Hint>
        ) : (
          <>
            {resourceTable(firstResources, false)}
            {moreResources.length > 0 && (
              <Disclosure
                id="account:resources"
                show={`All ${formatNumber(resources.length)}`}
                hide={`Show the first ${formatNumber(shown)} only`}
              >
                {resourceTable(moreResources, true)}
              </Disclosure>
            )}
          </>
        )}
      </Section>

      <Section
        title="Missions using this account"
        count={live.length}
        note={ACCOUNT_PAGES.missions}
        id="missions"
        testId="account-missions"
      >
        {missions.length === 0 ? (
          <Hint>No mission uses this account yet.</Hint>
        ) : (
          <>
            {live.length > 0 && (
              <Rows>
                {live.map((mission) => (
                  <MissionRow
                    key={mission.id}
                    mission={mission}
                    refs={refs}
                    youId={actor.user.id}
                    now={now}
                  />
                ))}
              </Rows>
            )}
            {ended.length > 0 && (
              <Disclosure
                id="account:ended-missions"
                show={`Show the ${formatNumber(ended.length)} that ended`}
                hide="Hide the ones that ended"
              >
                <Rows>
                  {ended.map((mission) => (
                    <MissionRow
                      key={mission.id}
                      mission={mission}
                      refs={refs}
                      youId={actor.user.id}
                      now={now}
                    />
                  ))}
                </Rows>
              </Disclosure>
            )}
          </>
        )}
      </Section>

      {!revoked && (
        <div className={styles.closing}>
          <span>
            Disconnecting destroys the credential
            {running.length > 0
              ? ` and stops the ${count(running.length, TERMS.mission)} that ${running.length === 1 ? 'runs' : 'run'} on it, for good.`
              : '; no mission runs on it today.'}
          </span>
          <RevokeConnection
            action={`${base}/revoke`}
            name={connection.displayName}
            running={running.length}
            atProvider={providerGrantForecast(detail.provider_label, detail.provider_grant)}
          />
        </div>
      )}
      {overlay}
    </DetailScope>
  );
}

/** "2 min ago", "now", "yesterday": `ago` gives a duration, a sentence wants the word after it. */
function agoWords(iso: string, now: Date): string {
  const words = ago(iso, now);
  return words === 'now' || words === 'yesterday' ? words : `${words} ago`;
}

/** Which broker a brokered account renews through, and whether the gateway checks the code it runs. */
function oauthBrokerFact(broker: NonNullable<ConnectionDetail['oauth_broker']>): string {
  if (broker.attested === null) return `${broker.name} · no longer configured`;
  return broker.attested
    ? `${broker.name} · attested: the gateway checks the code it runs before each use`
    : `${broker.name} · not attested (attestation: none): the gateway does not check the code it runs`;
}
