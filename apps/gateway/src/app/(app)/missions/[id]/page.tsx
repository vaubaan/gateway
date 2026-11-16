/**
 * `/missions/<id>` — one mission (spec §4.2 "On a mission"), in the order a person
 * needs it:
 *
 *   1. what it is and the state it is in (the header: "Edit mission", the setup kit,
 *      and in "···" the acts on the mission itself: activity, duplicate, leave, stop);
 *   2. what waits for an answer on this mission, with a link to answer — the
 *      one filled box of the page — or, for a teammate, whose answer it waits for;
 *   3. keys: who holds one, with what each key did in the current period, and
 *      every act on a key ("Add keys", generate, replace, revoke) — before the
 *      permissions, because it is short and they are long;
 *   4. the creation screen frozen: its name, period and end, then its cards, each
 *      with one more column, the use of the period per macro-action (the permission
 *      closest to its limit, each permission on hover);
 *   5. activity: a line of counts, the last calls one click away, the whole
 *      record on the mission's activity page;
 *   6. history: the versions of its configuration, newest first, each restorable by
 *      the creator (spec §4.2 "History").
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
 * and removes people, makes machine keys, edits and stops the mission.
 */
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { TrustRaiseOffer } from '@/components/missions/TrustRaiseOffer';
import { NeedsUser } from '@/components/auth/NeedsUser';
import { RelativeTime } from '@/components/RelativeTime';
import {
  AnswerList,
  AnswerRow,
  Avatar,
  ButtonLink,
  Callout,
  Disclosure,
  Hint,
  KeyValue,
  Mono,
  PageHeader,
  Section,
  StatusMark,
  SummaryLine,
  type ServiceMarkIcon,
} from '@/components/ui';
import { currentUser } from '@/lib/auth/session';
import {
  DOC_PAGES,
  ACTIONS,
  agoSentence,
  asksFirst,
  capitalize,
  count,
  expiresOn,
  issuerName,
  limitColumn,
  limitsResetEvery,
  listed,
  MISSION_ACTIONS,
  MISSION_HISTORY,
  MISSION_WORDS,
  periodWord,
  ROUTES,
  SECTIONS,
  TERMS,
  waitingFor,
  WAITING,
} from '@/lib/vocabulary';
import { TIMELINE_PARAMS } from '@/server/audit';
import { enumerateCatalog } from '@/lib/missions/catalog-view';
import { macroActionsOf } from '@/lib/missions/macro-actions';
import { riskPlanesOf } from '@/lib/services/planes';
import { serviceIconOf } from '@vaubaan/plugin-sdk';
import { missionGitViews } from '@/server/missions/git-view';
import { shortId } from '@/server/missions/short-id';
import { explainLostAccount, explainOrphan } from '@/server/missions/orphan-reason';
import { toolTitleOf } from '@/server/services/tool-titles';
import type { RequestCall } from '@/server/requests';
import { inboxRequestPath } from '@/server/requests/url';

import { CallHeadline } from '../../waiting/parts';

import styles from '../missions.module.css';
import cardStyles from '../cards/cards.module.css';
import { detailCards, type DetailCard } from '../cards/detail-cards';
import { LostAccountCard, type LostAccountView } from '../cards/lost-account-card';
import { MissionCard } from '../cards/mission-card';
import { createdBy, missionMark } from '../mission-view';
import { ActivityTable } from './activity-table';
import { CheckNow } from './check-now';
import { HistoryList } from './history-list';
import {
  ActButton,
  GenerateKeyButton,
  MissionActsProvider,
  MissionMenu,
  type KeyChoice,
} from './mission-actions';
import { TeamSection, type HolderCalls } from './team-section';

export const dynamic = 'force-dynamic';

/** How many of the last events the page shows; the rest is on the activity page. */
const LAST_EVENTS = 8;

interface Props {
  params: Promise<{ id: string }>;
  /** `add`: "Add keys" opens with the page on that choice (`teammate`, `machine`). */
  searchParams: Promise<{ edited?: string | string[]; add?: string | string[] }>;
}

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
  // Back from "Edit mission": the edit is saved (ADR mission-editable-after-issuance).
  const justEdited = isCreator && query.edited === '1';
  const now = new Date();
  // From the post-issuance page: "Add teammate" and "New machine key" land on the open dialog.
  const addOnOpen: KeyChoice | null =
    isCreator && state.kind !== 'revoked' && (query.add === 'teammate' || query.add === 'machine')
      ? query.add
      : null;
  const [team, activity, inbox, context, history] = await Promise.all([
    root.missions.team.team(user, id),
    root.audit.sessions.get(user, id),
    isCreator ? root.requests.service.inbox(user) : Promise.resolve([]),
    // The cards read the creator's lines against their authority now, as "Edit mission" does.
    isCreator ? root.missions.service.issuanceContext(user) : Promise.resolve([]),
    root.missions.service.history(user, id),
  ]);
  if (!team || !activity || !history) notFound();

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
  const orphanExplanation = orphan && explainOrphan(orphan, detail.accounts);
  // An account that no longer serves the mission says so in its own card, red and folded,
  // until the creator removes it in Edit mission (no banner, nothing removed on its own).
  const lostViews = new Map(
    detail.lost.map((part): [string, LostAccountView] => {
      const account = detail.accounts.find((c) => c.id === part.account_id);
      const words = explainLostAccount(part, account?.display_name ?? null, isCreator);
      return [
        part.account_id,
        {
          account_id: part.account_id,
          service_label: account?.service_label ?? 'An account',
          display_name: account?.display_name ?? null,
          summary: words.summary,
          lines: words.lines,
        },
      ];
    }),
  );
  const periodSeconds = detail.period.kind === 'recurring' ? detail.period.length_seconds : null;
  const period = periodWord(periodSeconds);

  const gitViews = missionGitViews({
    registry: root.registry,
    publicUrl: root.config.publicUrl,
    accounts: detail.accounts,
    policy: detail.policy,
  });
  const missionPath = `${ROUTES.missions}/${mission.id}`;
  // The creation screen, frozen: one card per resource set, with the use of the period.
  const cards = detailCards(detail, context, (service) => {
    const plugin = root.registry.get(service)?.plugin;
    return plugin
      ? {
          risks: enumerateCatalog(plugin.catalog),
          macro_actions: macroActionsOf(plugin.catalog),
          derives_env: typeof plugin.envOf === 'function',
        }
      : null;
  });
  const serviceOf = (service: string) => {
    const plugin = root.registry.get(service)?.plugin;
    return {
      icon: (plugin ? serviceIconOf(plugin) : null) satisfies ServiceMarkIcon | null,
      planes: plugin ? riskPlanesOf(plugin.dataModel, plugin.catalog) : null,
    };
  };
  const raisable = isCreator && detail.limits_editable;

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
  // Everything it did: the Activity's Timeline, filtered on this mission.
  const activityPath = `${ROUTES.activityTimeline}?${TIMELINE_PARAMS.mission}=${encodeURIComponent(mission.id)}`;
  const stoppable = isCreator && state.kind !== 'revoked';
  const editable = isCreator && detail.limits_editable;
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

  /** One frozen card; a lost account's offers nothing to raise, close or check. */
  const cardOf = ({ account, card, used, openUntil, lastCheckedAt }: DetailCard, lost: boolean) => {
    const service = serviceOf(account.service);
    return (
      <MissionCard
        key={card.key}
        readOnly
        account={account}
        card={card}
        icon={service.icon}
        planes={service.planes}
        limitLabel={limitColumn(periodSeconds)}
        today={{
          header: capitalize(period),
          period,
          used,
          openUntil,
          // Closing an opening: the creator, on the rule of every gate edit.
          closeOpenings:
            !lost && isCreator && detail.gates_editable ? { missionId: mission.id } : null,
          raiseHrefs:
            !lost && raisable
              ? Object.fromEntries(
                  account.macro_actions.map((action) => [
                    action.id,
                    `${missionPath}/edit?custom=${encodeURIComponent(card.id ?? '')}&action=${encodeURIComponent(action.id)}`,
                  ]),
                )
              : null,
        }}
        checked={
          card.future && !lost ? (
            <CheckNow
              missionId={mission.id}
              accountId={account.id}
              lastCheckedAt={lastCheckedAt}
              now={now.toISOString()}
              canCheck={isCreator && state.kind !== 'revoked'}
            />
          ) : null
        }
      />
    );
  };

  const secondary: React.ReactNode[] = [];
  if (editable) {
    secondary.push(
      <ButtonLink key="edit" href={`${missionPath}/edit`} data-testid="edit-mission">
        {MISSION_ACTIONS.editMission}
      </ButtonLink>,
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
    <MissionActsProvider team={team} kit={detail.kit} addOnOpen={addOnOpen}>
      <PageHeader
        doc={DOC_PAGES.mission}
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
        more={<MissionMenu missionId={mission.id} duplicable={isCreator} stoppable={stoppable} />}
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
          {issuedVia.mission_id !== null && issuedVia.mission_name !== null ? (
            <>
              Prepared for you by the agent of mission{' '}
              <Link href={`${ROUTES.missions}/${issuedVia.mission_id}`}>
                {issuedVia.mission_name}
              </Link>
              , through its Vaubaan account.
            </>
          ) : (
            <>
              Prepared for you by {issuerName(issuedVia)}, an app connected before connected apps
              were retired. The name is what the app said about itself; it is not verified.
            </>
          )}{' '}
          You are the creator of this mission and the only one who answers what its agents ask.
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
      {detail.trust_raises.length > 0 && (
        <div className={[styles.block, styles.trustRaises].join(' ')} data-testid="trust-raises">
          {detail.trust_raises.map((offer) => (
            <TrustRaiseOffer
              key={`${offer.resource_set_id}::${offer.macro_action_id}`}
              missionId={mission.id}
              offer={offer}
              accountName={offer.account_name}
            />
          ))}
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

      <TeamSection
        team={team}
        calls={calls}
        period={period}
        me={user.id}
        now={now.toISOString()}
        addKeys={
          isCreator && state.kind !== 'revoked' ? (
            <ActButton act="add-keys">{ACTIONS.addKeys}</ActButton>
          ) : null
        }
      />

      <div className={[styles.afterSection, styles.block].join(' ')}>
        <KeyValue
          items={[
            { term: 'Name', value: mission.name },
            { term: 'Limits reset', value: capitalize(limitsResetEvery(periodSeconds)) },
            {
              term: 'Ends',
              value: (
                <span title={mission.expiresAt ?? undefined}>
                  {capitalize(expiresOn(mission.expiresAt, now))}
                </span>
              ),
            },
          ]}
        />
      </div>
      <div className={[cardStyles.cards, styles.block].join(' ')} data-testid="mission-cards">
        {mission.accounts.map(({ accountId }) => {
          const ofAccount = cards.filter((c) => c.account.id === accountId);
          const lost = lostViews.get(accountId);
          if (!lost) return ofAccount.map((c) => cardOf(c, false));
          return (
            <LostAccountCard
              key={`lost:${accountId}`}
              lost={lost}
              icon={ofAccount[0] ? serviceOf(ofAccount[0].account.service).icon : null}
            >
              {ofAccount.length > 0 ? ofAccount.map((c) => cardOf(c, true)) : null}
            </LostAccountCard>
          );
        })}
      </div>

      {gitViews.length > 0 && (
        <Section
          id="git"
          title="Git"
          note="The key is the password; nothing else is needed."
          testId="mission-git"
        >
          {gitViews.map((git) => (
            <div key={git.service} className={styles.wrapAnywhere}>
              {gitViews.length > 1 && (
                <p>
                  <strong>{git.service}</strong>
                </p>
              )}
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
            </div>
          ))}
          <Hint>
            Every ref of a push is decided; one refused ref refuses the push. A refused push tells
            the agent why, with the link to hand you when you can say yes.
          </Hint>
        </Section>
      )}

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

      <Section
        id="history"
        title={MISSION_HISTORY.title}
        count={history.versions.length}
        testId="mission-history-section"
      >
        <p className={styles.quiet}>{MISSION_HISTORY.note}</p>
        <div className={styles.afterLine}>
          <HistoryList
            missionId={mission.id}
            versions={history.versions}
            restorable={history.restorable}
            now={now.toISOString()}
          />
        </div>
      </Section>
    </MissionActsProvider>
  );
}
