/**
 * `/activity` — the Overview, the home of Activity (spec §4.2 "Activity"): per
 * mission the reader may read, over today, 7 or 30 days (`?period=`, links,
 * no script), the calls allowed and refused, the requests waiting, the bytes
 * sent and received; behind each mission's disclosure, the requests per
 * account, the use per action in its current period, and who holds its keys
 * with their share. Above them, what stops working within
 * `EXPIRING_SOON_DAYS`, each with where it is fixed.
 *
 * Who reads what is the service's (`ActivityOverviewService`): the Timeline's
 * scope. Every number links to the Record or the Timeline filtered on it
 * (`overview-model.ts`): the Overview is the entry, the tabs the detail.
 *
 * An older address of `/activity` that carries the Record's filters (when this
 * address was the Record) still opens them on the Record.
 */
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { isOperatorPrincipal } from '@/components/auth/principal';
import {
  Callout,
  Disclosure,
  Hint,
  KeyHolder,
  Meter,
  PageHeader,
  Row,
  Rows,
  Segmented,
  ServiceMark,
  Stats,
  StatusMark,
  SummaryLine,
  type ServiceMarkIcon,
} from '@/components/ui';
import { requirePrincipal } from '@/lib/auth/session';
import { macroActionsOf } from '@/lib/missions/macro-actions';
import { enumerateCatalog } from '@/lib/missions/catalog-view';
import {
  count,
  DOC_PAGES,
  EXPIRY_WORDS,
  formatBytes,
  formatNumber,
  MISSION_STATES,
  OVERVIEW_LEDE,
  OVERVIEW_PERIODS,
  OVERVIEW_SCOPE,
  OVERVIEW_WORDS,
  PAGES,
  percentOf,
  periodWord,
  ROUTES,
  shortDate,
  TERMS,
} from '@/lib/vocabulary';
import {
  EXPIRING_SOON_DAYS,
  OVERVIEW_PERIODS as PERIODS,
  parseOverviewPeriod,
  type OverviewExpiry,
  type OverviewMission,
} from '@/server/audit';
import { serviceIconOf } from '@vaubaan/plugin-sdk';

import styles from './activity.module.css';
import ov from './overview.module.css';
import {
  actionUsages,
  isRecordAddress,
  overviewHref,
  recordHref,
  timelineHref,
  type OverviewCatalog,
} from './overview-model';

export const dynamic = 'force-dynamic';

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/** What a page needs of a service: its name, its mark, its catalog. */
interface ServiceFacts {
  readonly name: string;
  readonly icon: ServiceMarkIcon | null;
  readonly catalog: OverviewCatalog | null;
}

export default async function OverviewPage({ searchParams }: Props) {
  // Like every page of the surface: no session, no address of the record.
  const { root, principal } = await requirePrincipal();
  const query = await searchParams;
  if (isRecordAddress(query)) {
    const params = new URLSearchParams();
    for (const [name, value] of Object.entries(query)) {
      const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
      for (const one of values) params.append(name, one);
    }
    redirect(`${ROUTES.activityRecord}?${params.toString()}`);
  }
  const period = parseOverviewPeriod(query);
  const overview = await root.audit.overview.overview(principal, period);
  const now = new Date(overview.now);

  const services = new Map<string, ServiceFacts>();
  const serviceOf = (id: string): ServiceFacts => {
    let facts = services.get(id);
    if (!facts) {
      const plugin = root.registry.get(id)?.plugin;
      facts = {
        name: plugin?.displayName ?? id,
        icon: plugin ? serviceIconOf(plugin) : null,
        catalog: plugin
          ? {
              risks: enumerateCatalog(plugin.catalog),
              macro_actions: macroActionsOf(plugin.catalog),
            }
          : null,
      };
      services.set(id, facts);
    }
    return facts;
  };
  const scope = isOperatorPrincipal(principal)
    ? principal.kind === 'user'
      ? OVERVIEW_SCOPE.administrator
      : OVERVIEW_SCOPE.installer
    : OVERVIEW_SCOPE.person;

  return (
    <>
      <PageHeader
        title={PAGES.activity.title}
        lede={OVERVIEW_LEDE}
        doc={DOC_PAGES.activityOverview}
        width="wide"
      />

      <div className={styles.toolbar}>
        <Segmented
          label="Period"
          value={period}
          options={PERIODS.map((key) => ({
            value: key,
            label: OVERVIEW_PERIODS[key],
            href: overviewHref(key),
          }))}
        />
        <SummaryLine
          items={[
            { label: count(overview.missions.length, TERMS.mission) },
            { label: <span className={styles.quiet}>{scope}</span> },
          ]}
        />
      </div>

      {overview.expiring.length > 0 && (
        <div className={ov.expiring} data-testid="overview-expiring">
          <Callout tone="warn" title={OVERVIEW_WORDS.expiringTitle(EXPIRING_SOON_DAYS)}>
            <ul className={ov.expiryList}>
              {overview.expiring.map((expiry) => (
                <ExpiryLine
                  key={
                    expiry.kind === 'mission' ? `m-${expiry.mission_id}` : `a-${expiry.account_id}`
                  }
                  expiry={expiry}
                  now={now}
                  serviceName={expiry.kind === 'account' ? serviceOf(expiry.service).name : ''}
                />
              ))}
            </ul>
          </Callout>
        </div>
      )}

      {overview.missions.length === 0 ? (
        <Hint>{OVERVIEW_WORDS.nothing}</Hint>
      ) : (
        <div className={ov.missions} data-testid="overview-missions">
          {overview.missions.map((mission) => (
            <MissionBlock
              key={mission.id}
              mission={mission}
              since={overview.since}
              serviceOf={serviceOf}
            />
          ))}
        </div>
      )}

      <Hint>{OVERVIEW_WORDS.daysUtc}</Hint>
    </>
  );
}

function MissionBlock({
  mission,
  since,
  serviceOf,
}: {
  mission: OverviewMission;
  since: string;
  serviceOf: (id: string) => ServiceFacts;
}) {
  const { totals } = mission;
  const missionPath = `${ROUTES.missions}/${encodeURIComponent(mission.id)}`;
  const state = mission.status === 'orphaned' ? 'orphaned' : mission.state;
  const word = MISSION_STATES[state];
  // Waiting requests are answered by the creator on their page; a teammate reads them in the timeline.
  const waitingHref = mission.created_by_viewer ? ROUTES.waiting : timelineHref(mission.id);
  const accounts = mission.accounts;
  const usePeriod = periodWord(mission.period_seconds);
  return (
    <section
      className={ov.mission}
      aria-labelledby={`mission-${mission.id}`}
      data-testid={`overview-mission-${mission.id}`}
    >
      <header className={ov.head}>
        <h2 id={`mission-${mission.id}`} className={ov.name}>
          <Link href={missionPath}>{mission.name}</Link>
        </h2>
        {word.tone ? (
          <StatusMark tone={word.tone}>{word.label}</StatusMark>
        ) : (
          state !== 'active' && <span className={styles.quiet}>{word.label}</span>
        )}
      </header>

      <Stats
        items={[
          {
            label: OVERVIEW_WORDS.allowed,
            value: (
              <FigureLink
                href={recordHref({ mission: mission.id, from: since, decision: 'allowed' })}
                testId="allowed"
              >
                {formatNumber(totals.allowed)}
              </FigureLink>
            ),
          },
          {
            label: OVERVIEW_WORDS.refused,
            value: (
              <FigureLink
                href={recordHref({ mission: mission.id, from: since, decision: 'refused' })}
                testId="refused"
              >
                {formatNumber(totals.refused)}
              </FigureLink>
            ),
          },
          {
            label: OVERVIEW_WORDS.waiting,
            value: (
              <FigureLink href={waitingHref} testId="waiting">
                {formatNumber(totals.waiting)}
              </FigureLink>
            ),
            ...(totals.waiting > 0 ? { tone: 'warn' as const } : {}),
          },
          {
            label: OVERVIEW_WORDS.up,
            value: (
              <FigureLink href={recordHref({ mission: mission.id, from: since })} testId="up">
                {formatBytes(totals.request_bytes)}
              </FigureLink>
            ),
          },
          {
            label: OVERVIEW_WORDS.down,
            value: (
              <FigureLink href={recordHref({ mission: mission.id, from: since })} testId="down">
                {formatBytes(totals.response_bytes)}
              </FigureLink>
            ),
          },
        ]}
      />

      <Disclosure
        id={`activity-overview-${mission.id}`}
        show={OVERVIEW_WORDS.show}
        hide={OVERVIEW_WORDS.hide}
        testId={`overview-detail-${mission.id}`}
      >
        <div className={ov.detail}>
          <h3 className={ov.heading}>{OVERVIEW_WORDS.accounts}</h3>
          <Rows testId={`overview-accounts-${mission.id}`}>
            {accounts.map((account) => {
              const service = serviceOf(account.service);
              const calls = account.allowed + account.refused;
              return (
                <Row
                  key={account.id}
                  lead={<ServiceMark name={service.name} icon={service.icon} />}
                  title={account.display_name ?? service.name}
                  description={`${formatBytes(account.request_bytes)} ${OVERVIEW_WORDS.sentWord} · ${formatBytes(account.response_bytes)} ${OVERVIEW_WORDS.receivedWord}`}
                  end={
                    <FigureLink
                      href={recordHref({ mission: mission.id, from: since, account: account.id })}
                      testId={`account-${account.id}`}
                    >
                      {calls > 0 ? count(calls, TERMS.call) : OVERVIEW_WORDS.noCall}
                    </FigureLink>
                  }
                />
              );
            })}
          </Rows>

          <h3 className={ov.heading}>
            {OVERVIEW_WORDS.actions} · {usePeriod}
          </h3>
          {mission.state !== 'active' ? (
            <Hint>{OVERVIEW_WORDS.notRunning}</Hint>
          ) : (
            <Rows testId={`overview-actions-${mission.id}`}>
              {accounts.flatMap((account) => {
                const service = serviceOf(account.service);
                if (!service.catalog) return [];
                return actionUsages(account, service.catalog).map((action) => (
                  <Row
                    key={`${account.id}-${action.id}`}
                    title={action.label}
                    description={
                      accounts.length > 1
                        ? `${account.display_name ?? service.name} · ${action.top.label}`
                        : action.top.label
                    }
                    end={
                      <Link href={missionPath} className={ov.meter}>
                        <Meter used={action.top.used} limit={action.top.quota} threshold={0} />
                      </Link>
                    }
                  />
                ));
              })}
            </Rows>
          )}

          <h3 className={ov.heading}>{OVERVIEW_WORDS.holders}</h3>
          {mission.holders.length === 0 ? (
            <Hint>{OVERVIEW_WORDS.noCall}</Hint>
          ) : (
            <Rows testId={`overview-holders-${mission.id}`}>
              {mission.holders.map((holder) => {
                const calls = holder.allowed + holder.refused;
                return (
                  <Row
                    key={holder.holder ? `${holder.holder.kind}:${holder.holder.key}` : 'none'}
                    title={
                      holder.holder ? (
                        <KeyHolder
                          name={holder.holder.label}
                          kind={holder.holder.kind === 'named' ? 'machine' : 'person'}
                        />
                      ) : (
                        <span className={styles.quiet}>{OVERVIEW_WORDS.notAttributed}</span>
                      )
                    }
                    end={
                      <span>
                        <FigureLink
                          href={recordHref({
                            mission: mission.id,
                            from: since,
                            ...(holder.holder ? { holder: holder.holder } : {}),
                          })}
                          testId={`holder-${holder.holder ? holder.holder.key : 'none'}`}
                        >
                          {count(calls, TERMS.call)}
                        </FigureLink>
                        <span className={styles.quiet}> · {percentOf(holder.share)}</span>
                      </span>
                    }
                  />
                );
              })}
            </Rows>
          )}

          <p className={ov.links}>
            <Link href={recordHref({ mission: mission.id, from: since })}>
              {OVERVIEW_WORDS.record}
            </Link>
            {' · '}
            <Link href={timelineHref(mission.id)} data-testid={`overview-timeline-${mission.id}`}>
              {OVERVIEW_WORDS.timeline}
            </Link>
          </p>
        </div>
      </Disclosure>
    </section>
  );
}

/** A figure of the Overview: a link to the lines it counts. */
function FigureLink({
  href,
  testId,
  children,
}: {
  href: string;
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <Link href={href} className={ov.figure} data-testid={`figure-${testId}`}>
      {children}
    </Link>
  );
}

function ExpiryLine({
  expiry,
  now,
  serviceName,
}: {
  expiry: OverviewExpiry;
  now: Date;
  serviceName: string;
}) {
  if (expiry.kind === 'mission') {
    const missionPath = `${ROUTES.missions}/${encodeURIComponent(expiry.mission_id)}`;
    return (
      <li data-expiry="mission">
        {EXPIRY_WORDS.missionEnds(expiry.mission_name, shortDate(expiry.expires_at, now))} ·{' '}
        <Link href={expiry.fixable ? `${missionPath}/edit` : missionPath}>
          {expiry.fixable ? EXPIRY_WORDS.extend : EXPIRY_WORDS.openMission}
        </Link>
      </li>
    );
  }
  const name = `${serviceName} · ${expiry.display_name}`;
  const text =
    expiry.expired || expiry.expires_at === null
      ? EXPIRY_WORDS.accountExpired(name)
      : EXPIRY_WORDS.keyEnds(name, shortDate(expiry.expires_at, now));
  return (
    <li data-expiry="account">
      {text} ·{' '}
      {expiry.fixable ? (
        <Link href={`${ROUTES.accounts}/${encodeURIComponent(expiry.account_id)}`}>
          {EXPIRY_WORDS.reconnect}
        </Link>
      ) : (
        <>
          {EXPIRY_WORDS.ownerFixes} ·{' '}
          <Link href={`${ROUTES.missions}/${encodeURIComponent(expiry.mission_id)}`}>
            {expiry.mission_name}
          </Link>
        </>
      )}
    </li>
  );
}
