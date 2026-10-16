/**
 * The events of a mission as rows: when, who (the holder of the key, and the
 * label the agent gave itself), what was called, on which permission, and how
 * it ended. Five columns. Shared by the mission page (its last calls) and the
 * mission's activity page (the whole timeline).
 *
 * A key holder is authenticated: it is whose key the call presented. An agent
 * label is what a caller said about itself, and is drawn as such. The
 * exception rows are tinted and their last cell says why in words.
 */
import Link from 'next/link';

import { LocalDate } from '@/components/LocalDate';
import { AgentLabel, DataTable, Mono, type Column, type RowTone } from '@/components/ui';
import type { MissionSessionView, SessionEventView } from '@/server/audit';
import { riskReferencePath } from '@/server/providers/links';

import styles from '../missions.module.css';
import { yesOf } from '../mission-view';
import { eventWords } from './session/event-words';

type OpenRequests = MissionSessionView['open_requests'];

const ROW_TONE: Readonly<Record<'bad' | 'warn', RowTone>> = { bad: 'bad', warn: 'warn' };

export function ActivityTable({
  events,
  openRequests,
  labels,
  creator,
  caption,
  empty,
  testId,
}: {
  events: readonly SessionEventView[];
  openRequests: OpenRequests;
  /** What each permission lets an agent do, by its id. */
  labels: ReadonlyMap<string, string>;
  /** Who answers the requests, for a teammate; `null` when the reader is the creator. */
  creator: string | null;
  caption: string;
  empty: React.ReactNode;
  testId?: string;
}) {
  const openOf = (event: SessionEventView) =>
    openRequests.find((request) => request.id === event.request_id);
  const wordsOf = (event: SessionEventView) =>
    eventWords(event, { requestOpen: openOf(event) !== undefined });

  const columns: Column<SessionEventView>[] = [
    {
      id: 'when',
      header: 'When',
      nowrap: true,
      cell: (event) => (
        <span className={styles.quietText}>
          <LocalDate ts={event.ts} seconds />
        </span>
      ),
    },
    {
      id: 'who',
      header: 'Who',
      cell: (event) => (
        <span data-testid="event-holder">
          {event.holder?.label ?? event.actor_email ?? '—'}
          {event.holder?.kind === 'named' && (
            <span className={styles.quietText}> · machine key</span>
          )}
          {event.agent_label && (
            <>
              {' '}
              <AgentLabel>{event.agent_label}</AgentLabel>
            </>
          )}
        </span>
      ),
    },
    {
      id: 'action',
      header: 'Action',
      cell: (event) => (event.tool ? <Mono>{event.tool}</Mono> : '—'),
    },
    {
      id: 'permission',
      header: 'Permission',
      cell: (event) =>
        event.risk_ids.length === 0
          ? '—'
          : event.risk_ids.map((risk) => {
              const left = event.remaining?.[risk];
              return (
                <span key={risk} className={styles.permissionLine}>
                  {labels.get(risk) ?? ''}
                  <span className={styles.sub}>
                    <Mono quiet href={riskReferencePath(risk) ?? undefined}>
                      {risk}
                    </Mono>
                    {left !== undefined && ` · ${left} left`}
                  </span>
                </span>
              );
            }),
    },
    {
      id: 'outcome',
      header: 'Outcome',
      cell: (event) => {
        const words = wordsOf(event);
        const request = openOf(event);
        return (
          <span data-testid="event-detail">
            <span className={words.tone ? styles[`tone_${words.tone}`] : undefined}>
              {words.outcome}
            </span>
            {words.lines.map((detail) => (
              <span key={detail.text} className={styles.sub}>
                {detail.mono ? <Mono quiet>{detail.text}</Mono> : detail.text}
                {detail.at && (
                  <>
                    {' '}
                    <LocalDate ts={detail.at} />
                  </>
                )}
              </span>
            ))}
            {request &&
              (request.path ? (
                <Link href={request.path} className={styles.sub}>
                  Review and answer
                </Link>
              ) : (
                <span className={styles.sub}>waiting for {yesOf(creator)}</span>
              ))}
          </span>
        );
      },
    },
  ];

  return (
    <DataTable
      caption={caption}
      columns={columns}
      rows={events}
      rowKey={(event) => event.id}
      rowTone={(event) => {
        const { tone } = wordsOf(event);
        return tone ? ROW_TONE[tone] : undefined;
      }}
      density="tight"
      empty={empty}
      testId={testId}
    />
  );
}
