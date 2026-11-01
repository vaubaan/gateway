/**
 * `/missions/<id>` — one mission (spec §4.2, §4.4), in the order a person
 * needs it:
 *
 *   1. what it is and the state it is in (the header);
 *   2. what waits for an answer on this mission, with a link to answer — the
 *      one filled box of the page — or, for a teammate, whose answer it waits for;
 *   3. Can / Asks first / Cannot, and the one limit that is near;
 *   4. people and keys, with what each key did in the current period;
 *   5. permissions and usage — the explicit list, one click away — where the
 *      creator changes "ask me first", and "Change limits", which opens the same
 *      table in edit mode for the limits only (`?edit=limits`);
 *   6. activity: a line of counts, the last calls one click away, the whole
 *      record on the mission's activity page;
 *   7. for the creator of a mission that is not stopped, the zone that stops
 *      it — what stopping does, and the same confirmation as the "···" item.
 *
 * The header says when the mission was created, relative ("created 2 h ago",
 * the instant in its `title`), and a details line under it its short id (the
 * last 8 characters, the whole id in the `title`): two missions with the
 * same name — an import reissued — are told apart, and matched with what a
 * report or the audit names.
 *
 * The creator and the teammates of a mission read this page (spec §0 "Mission
 * member"). Each sees the acts the server would take from them and no other:
 * a teammate generates, replaces and revokes their own key; the creator adds
 * and removes people, makes machine keys, stops the mission.
 */
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { NeedsUser } from '@/components/auth/NeedsUser';
import { RelativeTime } from '@/components/RelativeTime';
import {
  AllowSummary,
  AnswerList,
  AnswerRow,
  Avatar,
  ButtonLink,
  Callout,
  Disclosure,
  EnvTag,
  Hint,
  Meter,
  Mono,
  PageHeader,
  Section,
  StatusMark,
  SummaryLine,
} from '@/components/ui';
import { currentUser } from '@/lib/auth/session';
import {
  ACTIONS,
  agoSentence,
  asksFirst,
  count,
  expiresOn,
  limitColumn,
  limitsResetEvery,
  listed,
  reachedOnAccount,
  MISSION_ACTIONS,
  MISSION_WORDS,
  periodWord,
  RESOURCE_SET_WORDS,
  ROUTES,
  SECTIONS,
  TERMS,
  until,
  waitingFor,
  WAITING,
} from '@/lib/vocabulary';
import { enumerateCatalog, groupVariants } from '@/lib/missions/catalog-view';
import { missionGitView } from '@/server/missions/git-view';
import { shortId } from '@/server/missions/short-id';
import { explainLost, explainOrphan } from '@/server/missions/orphan-reason';
import { riskExplainer } from '@/lib/providers/reference';
import { toolTitleOf } from '@/server/providers/tool-titles';
import type { RequestCall } from '@/server/requests';
import { inboxRequestPath } from '@/server/requests/url';
import { parseRiskId } from '@vaubaan/shared';

import { CallHeadline } from '../../waiting/parts';

import styles from '../missions.module.css';
import { allowLines, createdBy, missionMark, nearestLimit } from '../mission-view';
import { ActivityTable } from './activity-table';
import { LimitsEditor, type LimitGroup } from './limits-editor';
import {
  ActButton,
  GenerateKeyButton,
  MissionActsProvider,
  MissionMenu,
  StopMissionButton,
} from './mission-actions';
import { PermissionsUsage } from './permissions-usage';
import { TeamSection, type HolderCalls } from './team-section';

export const dynamic = 'force-dynamic';

/** How many of the last events the page shows; the rest is on the activity page. */
const LAST_EVENTS = 8;

interface Props {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ edit?: string | string[]; edited?: string | string[] }>;
}

/** The query that opens the permission table in edit mode for the limits. */
const EDIT_LIMITS = 'limits';

/** What waits on this mission, as the banner shows it. */
interface Waiting {
  readonly id: string;
  readonly kind: 'claim' | 'approval' | 'permission';
  readonly labels: readonly string[];
  /** An approval: what the agent wants to do, as the banner heads it. */
  readonly call: RequestCall | null;
  readonly created_at: string;
  /** Where the creator answers; `null` for a teammate. */
  readonly path: string | null;
}

export default async function MissionPage({ params, searchParams }: Props) {
  const session = await currentUser();
  if (!session) return <NeedsUser />;
  const { id } = await params;
  const { root, user } = session;
  const detail = await root.missions.service.get(user, id);
  if (!detail) notFound();
  const { mission, state, orphan, issued_via: issuedVia } = detail;
  const isCreator = detail.role === 'creator';
  const query = await searchParams;
  const editingLimits = isCreator && detail.limits_editable && query.edit === EDIT_LIMITS;
  // Back from "Edit mission": the edit is saved (ADR mission-editable-after-issuance).
  const justEdited = isCreator && query.edited === '1';
  const now = new Date();
  const [team, activity, inbox] = await Promise.all([
    root.missions.team.team(user, id),
    root.audit.sessions.get(user, id),
    isCreator ? root.requests.service.inbox(user) : Promise.resolve([]),
  ]);
  if (!team || !activity) notFound();

  const creatorName = isCreator ? null : (detail.creator.email ?? 'the creator');
  const labelOf = new Map(detail.policy.map((entry) => [entry.risk_id, entry.label]));
  const waiting: Waiting[] = isCreator
    ? inbox
        .filter((request) => request.mission.id === mission.id)
        .map((request) => ({
          id: request.id,
          kind: request.kind,
          labels: request.risks.map((risk) => risk.label),
          call: request.call,
          created_at: request.created_at,
          path: inboxRequestPath(request.id),
        }))
    : activity.open_requests.map((request) => ({
        id: request.id,
        kind: request.kind,
        labels: [labelOf.get(request.risk_id) ?? request.risk_id],
        // A teammate reads the same head as the creator: the tool and the resource are
        // on the call's line of the activity they may read; never the arguments.
        call: request.tool
          ? {
              tool: request.tool,
              title: toolTitleOf(root.registry, request.tool),
              resource: request.resource_ref,
            }
          : null,
        created_at: request.created_at,
        path: null,
      }));

  const mark = missionMark(state, waiting.length, creatorName, detail.lost.length);
  const orphanExplanation = orphan && explainOrphan(orphan, detail.connections);
  // An orphaned mission says why as a whole; a running one says which accounts it lost.
  const lostExplanation = orphan ? null : explainLost(detail.lost, detail.connections);
  const periodSeconds = detail.period.kind === 'recurring' ? detail.period.length_seconds : null;
  const period = periodWord(periodSeconds);

  // What the mission does not hold, by what it would have allowed: the "Cannot" line.
  const held = new Set<string>(detail.policy.map((entry) => entry.risk_id));
  const notIncluded = detail.connections.flatMap((connection) => {
    const registered = root.registry.get(connection.provider);
    if (!registered) return [];
    const left = enumerateCatalog(registered.plugin.catalog)
      .filter((risk) => !held.has(risk.risk_id) && !risk.deprecated && !risk.fallback)
      .sort((a, b) => b.severity - a.severity);
    return groupVariants(left).map((family) => family.label);
  });
  const lines = allowLines(detail.policy, notIncluded);
  const near = state.kind === 'active' ? nearestLimit(detail.policy) : null;
  const explain = riskExplainer(root.registry);
  const git = missionGitView({
    registry: root.registry,
    publicUrl: root.config.publicUrl,
    connections: detail.connections,
    policy: detail.policy,
  });
  const missionPath = `${ROUTES.missions}/${mission.id}`;
  const limitGroups: LimitGroup[] = editingLimits
    ? detail.connections
        .flatMap((connection) => {
          // One group per account; per resource set when it has several (risk model §4.7).
          const several = connection.resource_sets.length > 1;
          return (several ? connection.resource_sets : [null]).map((set) => ({ connection, set }));
        })
        .map(({ connection, set }) => ({
          key: set ? `${connection.id}:${set.id}` : connection.id,
          title: set
            ? `${connection.provider_label} · ${connection.display_name} · ${RESOURCE_SET_WORDS.title(set.position)}`
            : `${connection.provider_label} · ${connection.display_name}`,
          note: set
            ? reachedOnAccount(
                set.resources.map((r) => r.display_name || r.ref),
                set.reaches_later,
              )
            : reachedOnAccount(
                connection.resources.map((r) => r.display_name || r.ref),
                connection.reaches_later,
              ),
          rows: detail.policy
            .filter((entry) =>
              set
                ? entry.resource_set_id === set.id
                : parseRiskId(entry.risk_id)?.provider === connection.provider,
            )
            .map((entry) => ({
              key: `${entry.resource_set_id ?? ''}:${entry.risk_id}`,
              resource_set_id: entry.resource_set_id ?? '',
              suffix: set && set.position > 1 ? `-set${set.position}` : '',
              risk_id: entry.risk_id,
              label: entry.label,
              level: entry.level ?? 'low',
              env: explain(entry.risk_id)?.env ?? null,
              quota: entry.quota,
              rate_max: entry.rate_limit.max,
              rate_window_seconds: entry.rate_limit.window_seconds,
              gate: entry.gate,
              used: entry.remaining === null ? null : entry.quota - entry.remaining,
            })),
        }))
        .filter((group) => group.rows.length > 0)
    : [];

  const calls: HolderCalls[] = activity.holder_activity.flatMap((entry) =>
    entry.holder
      ? [
          {
            kind: entry.holder.kind,
            key: entry.holder.key,
            allowed: entry.allowed,
            refused: entry.refused,
            last_seen_at: entry.last_seen_at,
          },
        ]
      : [],
  );
  const allowed = activity.holder_activity.reduce((sum, entry) => sum + entry.allowed, 0);
  const refused = activity.holder_activity.reduce((sum, entry) => sum + entry.refused, 0);
  const lastCall = activity.holder_activity
    .map((entry) => entry.last_seen_at)
    .sort()
    .at(-1);
  const activityPath = `${ROUTES.missions}/${mission.id}/session`;
  const stoppable = isCreator && state.kind !== 'revoked';
  const needsMyKey = team.issuable && !team.my_token;

  const [first, ...others] = waiting;
  const answersOf = (request: Waiting) =>
    request.path ? (
      <ButtonLink href={request.path} variant="primary">
        Review and answer
      </ButtonLink>
    ) : undefined;
  const titleOf = (request: Waiting) => (
    <>
      {request.kind === 'claim' ? (
        `${listed([...request.labels], 2)} reached its limit`
      ) : request.call ? (
        <CallHeadline call={request.call} />
      ) : (
        listed([...request.labels], 2)
      )}{' '}
      · {request.kind === 'claim' && isCreator ? 'asks you for more room' : waitingFor(creatorName)}
    </>
  );
  const descriptionOf = (request: Waiting) => (
    <>
      {request.kind === 'approval' && <>needs “{listed([...request.labels], 2)}” · </>}
      {askerOf(request)?.agent_label && `${askerOf(request)?.agent_label} · `}
      asked {agoSentence(request.created_at, now)}
      {!isCreator && ' · only the creator of the mission answers'}
    </>
  );
  // Who asked is the holder of the key the refused call presented, when the event is still listed.
  const askerOf = (request: Waiting) =>
    activity.events.find((event) => event.request_id === request.id && event.holder !== null);
  const whoAsks = (request: Waiting) => {
    const holder = askerOf(request)?.holder;
    return holder ? (
      <Avatar name={holder.label} kind={holder.kind === 'named' ? 'machine' : 'person'} size="md" />
    ) : (
      <Avatar name="agent" kind="machine" size="md" />
    );
  };

  const secondary: React.ReactNode[] = [];
  if (isCreator && state.kind !== 'revoked') {
    secondary.push(
      <ActButton key="people" act="add-people">
        {ACTIONS.addPeople}
      </ActButton>,
    );
  }
  if (team.my_token) {
    secondary.push(
      <ActButton key="kit" act="kit">
        {ACTIONS.setupKit}
      </ActButton>,
    );
  }

  return (
    <MissionActsProvider team={team} kit={detail.kit}>
      <PageHeader
        crumbs={[{ label: 'Missions', href: ROUTES.missions }, { label: mission.name }]}
        title={mission.name}
        status={
          mark.tone ? (
            <StatusMark tone={mark.tone} testId="mission-state">
              {mark.label}
            </StatusMark>
          ) : mark.over ? (
            <StatusMark testId="mission-state">{mark.label}</StatusMark>
          ) : undefined
        }
        lede={
          <>
            {createdBy(detail.creator.email, isCreator)}{' '}
            <RelativeTime at={mission.createdAt} now={now} testId="mission-created" />
            {detail.connections.map((connection) => (
              <span key={connection.id}>
                {' · '}
                {connection.provider_label}{' '}
                {connection.reaches_later ? (
                  <span data-testid="whole-account">
                    {connection.display_name}, {MISSION_WORDS.wholeAccount}
                  </span>
                ) : connection.resources.length === 0 ? (
                  connection.display_name
                ) : (
                  listed(
                    connection.resources.map((r) => {
                      const name = r.display_name || r.ref;
                      return connection.created_resource_ids?.includes(r.id)
                        ? `${name} (${MISSION_WORDS.createdByMission})`
                        : name;
                    }),
                    2,
                  )
                )}
                {[...new Set(connection.resources.flatMap((r) => (r.env ? [r.env] : [])))].map(
                  (env) => (
                    <span key={env} className={styles.inlineTag}>
                      <EnvTag env={env} />
                    </span>
                  ),
                )}
                {connection.lost && (
                  <span data-testid={`account-lost-${connection.id}`}> (no longer serves)</span>
                )}
              </span>
            ))}
            {' · '}
            {limitsResetEvery(periodSeconds)} ·{' '}
            <span title={mission.expiresAt ?? undefined}>{expiresOn(mission.expiresAt, now)}</span>
          </>
        }
        primary={needsMyKey ? <GenerateKeyButton /> : undefined}
        secondary={
          secondary.length === 2
            ? [secondary[0], secondary[1]]
            : secondary.length === 1
              ? [secondary[0]]
              : undefined
        }
        more={
          <MissionMenu
            missionId={mission.id}
            duplicable={isCreator}
            stoppable={stoppable}
            limitsHref={
              isCreator && detail.limits_editable
                ? `${missionPath}?edit=${EDIT_LIMITS}#permissions`
                : null
            }
            editHref={isCreator && detail.limits_editable ? `${missionPath}/edit` : null}
          />
        }
      />

      <p className={styles.details} data-testid="mission-details">
        {MISSION_WORDS.missionId}{' '}
        <span title={mission.id}>
          <Mono quiet>{shortId(mission.id)}</Mono>
        </span>
      </p>

      {justEdited && (
        <Callout tone="ok" title={MISSION_WORDS.edited} testId="mission-edited">
          The key, the session and what was used this period are unchanged.
        </Callout>
      )}

      {!isCreator && (
        <p className={styles.headNote} data-testid="shared-with-me">
          {MISSION_WORDS.teammateRule} What its agents ask is answered by{' '}
          {detail.creator.email ?? 'its creator'} alone.
        </p>
      )}

      {issuedVia && (
        <p className={styles.headNote} data-testid="issued-via">
          Prepared for you by {issuedVia.client_name},{' '}
          <Link href={`${ROUTES.connectedApps}#${issuedVia.delegation_id}`}>a connected app</Link> (
          <Mono quiet>{issuedVia.client_id}</Mono>). The name is what the app said about itself; it
          is not verified. You are the creator of this mission and the only one who answers what its
          agents ask.
        </p>
      )}

      {orphanExplanation && (
        <div className={styles.block}>
          <Callout
            tone={orphanExplanation.reversible ? 'warn' : 'bad'}
            title={orphanExplanation.title}
            testId="orphan-callout"
          >
            {orphanExplanation.lines.map((line) => (
              <p key={line}>{line}</p>
            ))}
          </Callout>
        </div>
      )}

      {lostExplanation && (
        <div className={styles.block}>
          <Callout
            tone={lostExplanation.final ? 'bad' : 'warn'}
            title={lostExplanation.title}
            testId="lost-accounts-callout"
          >
            {lostExplanation.lines.map((line) => (
              <p key={line}>{line}</p>
            ))}
          </Callout>
        </div>
      )}

      {first && !orphanExplanation && (
        <div className={styles.block}>
          <AnswerRow
            boxed
            who={whoAsks(first)}
            title={titleOf(first)}
            description={descriptionOf(first)}
            answers={answersOf(first)}
            testId="mission-waiting"
          />
          {others.length > 0 && (
            <Hint>
              {isCreator ? (
                <>
                  And {count(others.length, TERMS.request)} more on this mission, in{' '}
                  <Link href={ROUTES.waiting}>{SECTIONS.waiting}</Link>.
                </>
              ) : (
                `And ${count(others.length, TERMS.request)} more, also ${waitingFor(creatorName)}.`
              )}
            </Hint>
          )}
        </div>
      )}
      {first && orphanExplanation && (
        <div className={styles.block}>
          <AnswerList label={SECTIONS.waiting} testId="mission-waiting">
            {waiting.map((request) => (
              <AnswerRow
                key={request.id}
                who={whoAsks(request)}
                title={titleOf(request)}
                description={descriptionOf(request)}
                answers={answersOf(request)}
              />
            ))}
          </AnswerList>
        </div>
      )}

      <AllowSummary
        can={lines.can}
        asks={lines.asks}
        cannot={lines.cannot}
        asksLabel={asksFirst(creatorName)}
        limits={
          state.kind !== 'active' ? undefined : near ? (
            <>
              <Meter used={near.used} limit={near.limit} threshold={0} label={near.label} />
              {near.near === 1
                ? ' · the only one near its limit'
                : ` · the closest of ${near.near} near their limit`}
            </>
          ) : (
            `Nothing is near its limit · ${limitsResetEvery(periodSeconds)}.`
          )
        }
        testId="mission-allows"
      />

      <TeamSection team={team} calls={calls} period={period} me={user.id} now={now.toISOString()} />

      {git && (
        <Section
          id="git"
          title="Git"
          note="The key is the password; nothing else is needed."
          testId="mission-git"
        >
          <div className={styles.wrapAnywhere}>
            <p>
              {git.remotes.length === 1 ? 'Git remote' : 'Git remotes'}:{' '}
              {git.remotes.map((url, i) => (
                <span key={url}>
                  {i > 0 && ' · '}
                  <Mono>{url}</Mono>
                </span>
              ))}
            </p>
            <p data-testid="git-can">
              <strong>With git, the agent can:</strong>{' '}
              {git.can.length > 0 ? git.can.join(' · ') : 'nothing yet'}.
            </p>
            {git.asks.length > 0 && (
              <p data-testid="git-asks">
                <strong>{asksFirst(creatorName)}:</strong> {git.asks.join(' · ')}.
              </p>
            )}
            {git.cannot.length > 0 && (
              <p data-testid="git-cannot">
                <strong>It cannot:</strong> {git.cannot.join(' · ')}.
              </p>
            )}
            <Hint>
              Every ref of a push is decided; one refused ref refuses the push. A refused push tells
              the agent why, with the link to hand you when you can say yes.
            </Hint>
          </div>
        </Section>
      )}

      <Section
        id="permissions"
        title={SECTIONS.permissionsAndUsage}
        count={detail.policy.length}
        note={
          editingLimits ? (
            'Change a limit up or down. What was used stays used.'
          ) : isCreator && detail.limits_editable ? (
            <>
              <ButtonLink href={`${missionPath}/edit`} size="sm" data-testid="edit-mission">
                {MISSION_ACTIONS.editMission}
              </ButtonLink>
              <ButtonLink
                href={`${missionPath}?edit=${EDIT_LIMITS}#permissions`}
                size="sm"
                data-testid="change-limits"
              >
                {MISSION_ACTIONS.changeLimits}
              </ButtonLink>
            </>
          ) : (
            'The explicit list this mission carries.'
          )
        }
        testId="mission-permissions"
      >
        {editingLimits ? (
          <LimitsEditor
            missionId={mission.id}
            missionName={mission.name}
            groups={limitGroups}
            limitLabel={limitColumn(periodSeconds)}
            periodWord={period}
            resetWords={
              state.kind === 'active' && state.period.end
                ? `until the limits reset (${until(state.period.end, now)})`
                : null
            }
            missionPath={missionPath}
          />
        ) : (
          <Disclosure
            id={`mission:${mission.id}:permissions`}
            show={`All ${count(detail.policy.length, TERMS.risk)}, with what was used`}
            hide="Hide the permissions"
            testId="permissions-disclosure"
          >
            <PermissionsUsage
              detail={detail}
              explain={explain}
              periodSeconds={periodSeconds}
              editable={isCreator && detail.gates_editable}
            />
            <Hint>Not in this mission, therefore refused with the reason: {lines.cannot}</Hint>
            {isCreator && detail.gates_editable && (
              <Hint>You choose here what asks you first.</Hint>
            )}
          </Disclosure>
        )}
      </Section>

      <Section
        id="activity"
        title={MISSION_ACTIONS.activity}
        note={<Link href={activityPath}>Everything this mission did</Link>}
        testId="mission-activity"
      >
        {state.kind !== 'active' ? (
          <p className={styles.quiet}>
            No call is served: the mission is {mark.label.toLowerCase()}. What it did stays in its
            activity.
          </p>
        ) : allowed + refused === 0 ? (
          <p className={styles.quiet}>
            No call {period} yet. {WAITING.recorded}
          </p>
        ) : (
          <SummaryLine
            items={[
              { label: `${count(allowed + refused, TERMS.call)} ${period}` },
              ...(refused > 0 ? [{ label: `${refused} refused` }] : []),
              ...(lastCall ? [{ label: `last call ${agoSentence(lastCall, now)}` }] : []),
            ]}
          />
        )}
        {activity.events.length > 0 && (
          <div className={styles.afterLine}>
            <Disclosure
              id={`mission:${mission.id}:activity`}
              show="Show the last events"
              hide="Hide the last events"
              testId="activity-disclosure"
            >
              <ActivityTable
                events={activity.events.slice(0, LAST_EVENTS)}
                openRequests={activity.open_requests}
                labels={labelOf}
                creator={creatorName}
                caption="The last events of this mission"
                empty={null}
                testId="mission-events"
              />
            </Disclosure>
          </div>
        )}
      </Section>

      {stoppable && (
        <Section id="stop" title={MISSION_WORDS.stopTitle} testId="mission-stop">
          <p className={styles.quiet}>{MISSION_WORDS.stopWhat}</p>
          <div className={styles.afterLine}>
            <StopMissionButton />
          </div>
        </Section>
      )}
    </MissionActsProvider>
  );
}
