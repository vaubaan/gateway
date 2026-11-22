/**
 * `/activity/timeline` — the session events of every mission the reader may
 * read (spec §4.2 "Activity", §3.3): calls, requests and their answers,
 * resets, limits, gates and keys, newest first, worded like the mission's own
 * page (`eventWords`). Filtered by mission (`?mission=`), key holder
 * (`?holder=`: an email, a machine key's name, or `member:<id>` /
 * `named:<name>`), agent label (`?agent=`) or the calls without one
 * (`?unlabelled=1`); the filters apply as they are chosen (`FilterForm`).
 *
 * Who reads what is the service's (`ActivityTimelineService`): the sessions
 * of the missions the reader created or is a teammate of; every session for
 * an administrator. Pages of 50 events in a box of bounded height, reached by
 * keyset from the address, like the Record (`server/audit/paging.ts`).
 */
import Link from 'next/link';

import { isOperatorPrincipal } from '@/components/auth/principal';
import { Button, Callout, Hint, Input, PageHeader, Select, SummaryLine } from '@/components/ui';
import { requirePrincipal } from '@/lib/auth/session';
import { riskExplainer } from '@/lib/services/reference';
import {
  ACTIVITY_WORDS,
  count,
  DOC_PAGES,
  PAGES,
  ROUTES,
  TIMELINE_SCOPE,
  timelineLede,
} from '@/lib/vocabulary';
import {
  AUDIT_PARAMS,
  parsePage,
  parseTimelineQuery,
  TIMELINE_PAGE_SIZE,
  TIMELINE_PARAMS,
  timelineQueryString,
  type ParsedTimelineQuery,
} from '@/server/audit';

import { ActivityTable } from '../../missions/[id]/activity-table';
import styles from '../activity.styles';
import { FilterForm } from '../filter-form';
import { linesWords, neighboursOf, setPage, type PageLink } from '../page-links';
import { Pager } from '../pager';

export const dynamic = 'force-dynamic';

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

type Raw = ParsedTimelineQuery['raw'];

/** The Timeline with these filters, on this page. */
function hrefOf(raw: Raw, page?: PageLink): string {
  const params = new URLSearchParams(timelineQueryString(raw));
  if (page) setPage(params, page);
  const query = params.toString();
  return `${ROUTES.activityTimeline}${query ? `?${query}` : ''}`;
}

export default async function TimelinePage({ searchParams }: Props) {
  const { root, principal } = await requirePrincipal();
  const params = await searchParams;
  const query = parseTimelineQuery(params);
  const { raw, filters } = query;
  const at = parsePage(params);
  const here: PageLink = { position: at.position, at: at.at };
  const [page, options] = await Promise.all([
    root.audit.timeline.search(principal, filters, at.position),
    root.audit.query.filterOptions(principal),
  ]);
  const explain = riskExplainer(root.registry);
  const labels = new Map(
    page.events
      .flatMap((event) => event.risk_ids)
      .map((riskId) => [riskId, explain(riskId)?.label ?? ''] as const),
  );
  const around = neighboursOf(page, here, page.events.length, TIMELINE_PAGE_SIZE);
  const problems = [...query.problems, ...at.problems];
  const filtered = Object.keys(raw).length > 0;
  const scope = isOperatorPrincipal(principal)
    ? principal.kind === 'user'
      ? TIMELINE_SCOPE.administrator
      : TIMELINE_SCOPE.installer
    : TIMELINE_SCOPE.person;
  const missions =
    raw.mission && !options.missions.some((m) => m.id === raw.mission)
      ? [...options.missions, { id: raw.mission, name: raw.mission }]
      : options.missions;
  const calls = page.events.filter((event) => event.kind.startsWith('call-')).length;
  const mission = filters.missionId;

  return (
    <>
      <PageHeader
        title={PAGES.activity.title}
        lede={timelineLede(root.config.retentionDays)}
        doc={DOC_PAGES.activityTimeline}
        width="wide"
      />

      {problems.length > 0 && (
        <div className={styles.problems}>
          <Callout tone="warn" title="Some filters were not understood and were left out">
            {problems.map((problem) => (
              <p key={problem}>{problem}</p>
            ))}
          </Callout>
        </div>
      )}

      <FilterForm action={ROUTES.activityTimeline} className={styles.filters}>
        <div className={styles.filterRow}>
          <Select
            size="sm"
            name={TIMELINE_PARAMS.mission}
            defaultValue={raw.mission ?? ''}
            aria-label={ACTIVITY_WORDS.mission}
            className={styles.select}
          >
            <option value="">All missions</option>
            {missions.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </Select>
          <Input
            size="sm"
            name={TIMELINE_PARAMS.holder}
            defaultValue={raw.holder ?? ''}
            placeholder="Who: an email or a machine key"
            aria-label="Who: an email or a machine key"
            autoComplete="off"
            className={styles.tool}
          />
          <Input
            size="sm"
            name={TIMELINE_PARAMS.agent}
            defaultValue={raw.agent ?? ''}
            placeholder="Agent label, exact"
            aria-label="Agent label, exact"
            autoComplete="off"
            className={styles.tool}
          />
          <label className={styles.check}>
            <input
              type="checkbox"
              name={TIMELINE_PARAMS.unlabelled}
              value="1"
              defaultChecked={filters.unlabelled}
            />
            Calls without a label
          </label>
          <noscript>
            <Button type="submit" size="sm">
              {ACTIVITY_WORDS.show}
            </Button>
          </noscript>
          {filtered && (
            <Link href={ROUTES.activityTimeline} className={styles.clear}>
              {ACTIVITY_WORDS.clear}
            </Link>
          )}
        </div>
        {mission && (
          <p className={styles.missionLinks} data-testid="timeline-mission-links">
            This mission:{' '}
            <Link href={`${ROUTES.missions}/${encodeURIComponent(mission)}/session`}>
              what waits, who called and what was used
            </Link>
            {' · '}
            <Link
              href={`${ROUTES.activityRecord}?${AUDIT_PARAMS.mission}=${encodeURIComponent(mission)}`}
            >
              its record
            </Link>
          </p>
        )}
      </FilterForm>

      <div className={styles.toolbar}>
        <SummaryLine
          items={[
            { label: count(page.events.length, { one: 'event', many: 'events' }) },
            ...(calls > 0 ? [{ label: count(calls, { one: 'call', many: 'calls' }) }] : []),
            { label: <span className={styles.quiet}>{scope}</span> },
          ]}
        />
        <Pager
          lines={linesWords(here.at, page.events.length)}
          newest={around.newest && hrefOf(raw, around.newest)}
          newer={around.newer && hrefOf(raw, around.newer)}
          older={around.older && hrefOf(raw, around.older)}
        />
      </div>

      {/* A new page starts at the top of its box: the box is new with each page. */}
      <div key={hrefOf(raw, here)} className={styles.region} data-testid="timeline-table">
        <ActivityTable
          events={page.events}
          openRequests={page.open_requests}
          labels={labels}
          creator={null}
          missionOf={mission ? undefined : (event) => event.mission}
          caption="The events of the missions, newest first"
          empty={<Hint>{filtered ? 'No event matches these filters.' : 'No event yet.'}</Hint>}
          testId="timeline-events"
        />
      </div>

      <Hint>
        Newest first, {TIMELINE_PAGE_SIZE} events a page · A label is what an agent said about
        itself: not verified, and it decides nothing.
      </Hint>
    </>
  );
}
