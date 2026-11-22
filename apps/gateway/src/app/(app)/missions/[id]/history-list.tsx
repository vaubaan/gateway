'use client';

/**
 * The History of a mission (spec §4.2 "History"): the versions of its configuration,
 * newest first — who, when, why, the clauses of what moved — each with what changed
 * from the previous one behind a disclosure, and, for the creator on a past version,
 * "Restore this version".
 *
 * Restoring asks nothing (it is reversible: restore again). The button spins while the
 * restore is written (`POST /api/missions/:id/versions/:n/restore`), then the section
 * says "Restored" — or what was left out, or why it was refused — and the page reads
 * the mission again: the new version heads the list.
 */
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { RelativeTime } from '@/components/RelativeTime';
import { Avatar, Button, Callout, Disclosure, Row, Rows, Tag } from '@/components/ui';
import { useAction } from '@/lib/http/post-json';
import type { MissionVersionCause } from '@/lib/missions/versions';
import { MISSION_HISTORY } from '@/lib/vocabulary';
import type { MissionVersionView } from '@/server/missions/history';

import styles from '../missions.styles';

/** Every cause has its words: a new cause does not compile without them. */
const CAUSES: Readonly<Record<MissionVersionCause, string>> = MISSION_HISTORY.causes;

/** What the last restore said, shown at the head of the section. */
type Outcome =
  | {
      readonly ok: true;
      readonly from: number;
      readonly version: number | null;
      readonly dropped: readonly string[];
    }
  | { readonly ok: false; readonly message: string; readonly dropped: readonly string[] };

function droppedOf(body: unknown): string[] {
  if (typeof body !== 'object' || body === null) return [];
  const dropped = (body as { dropped?: unknown }).dropped;
  return Array.isArray(dropped) ? dropped.filter((d): d is string => typeof d === 'string') : [];
}

function versionOf(body: unknown): number | null {
  if (typeof body !== 'object' || body === null) return null;
  const version = (body as { version?: unknown }).version;
  return typeof version === 'number' ? version : null;
}

export function HistoryList({
  missionId,
  versions,
  restorable,
  now,
}: {
  missionId: string;
  versions: readonly MissionVersionView[];
  /** The reader may restore (the creator, on an editable mission). */
  restorable: boolean;
  /** The instant the page was rendered at. */
  now: string;
}) {
  const router = useRouter();
  const { busy, run } = useAction();
  const [restoring, setRestoring] = useState<number | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  async function restore(number: number) {
    setRestoring(number);
    setOutcome(null);
    const answer = await run(
      `/api/missions/${encodeURIComponent(missionId)}/versions/${number}/restore`,
      undefined,
      { errorOf: () => null },
    );
    setRestoring(null);
    setOutcome(
      answer.ok
        ? {
            ok: true,
            from: number,
            version: versionOf(answer.body),
            dropped: droppedOf(answer.body),
          }
        : { ok: false, message: answer.message, dropped: droppedOf(answer.body) },
    );
    if (answer.ok) router.refresh();
  }

  return (
    <>
      {outcome && (
        <div className={styles.afterLine}>
          {outcome.ok ? (
            <Callout tone="ok" title={MISSION_HISTORY.restored} testId="mission-restored">
              <p>
                {outcome.version === null
                  ? MISSION_HISTORY.alreadyCurrent(outcome.from)
                  : MISSION_HISTORY.restoredAs(outcome.from, outcome.version)}
              </p>
              {outcome.dropped.length > 0 && (
                <>
                  <p>{MISSION_HISTORY.leftOut}</p>
                  <ul data-testid="restore-left-out">
                    {outcome.dropped.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                </>
              )}
            </Callout>
          ) : (
            <Callout tone="bad" title={MISSION_HISTORY.notRestored} testId="mission-not-restored">
              <p>{outcome.message}</p>
              {outcome.dropped.length > 0 && (
                <ul>
                  {outcome.dropped.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              )}
            </Callout>
          )}
        </div>
      )}
      <Rows label={MISSION_HISTORY.title} testId="mission-history">
        {versions.map((version) => (
          <Row
            key={version.number}
            testId={`mission-version-${version.number}`}
            lead={
              <Avatar
                name={version.author.label}
                kind={version.author.kind === 'person' ? 'person' : 'machine'}
                size="md"
              />
            }
            title={
              <>
                {MISSION_HISTORY.version(version.number)} ·{' '}
                {version.restored_from !== null
                  ? MISSION_HISTORY.restoredFrom(version.restored_from)
                  : CAUSES[version.cause]}
              </>
            }
            description={
              <>
                {MISSION_HISTORY.by(version.author.label)} ·{' '}
                <RelativeTime at={version.created_at} now={new Date(now)} />
                {version.clauses.length > 0 && <> · {version.clauses.join(', ')}</>}
                {version.details.length > 0 && (
                  <Disclosure
                    id={`mission:${missionId}:version:${version.number}`}
                    show={MISSION_HISTORY.showChanges}
                    hide={MISSION_HISTORY.hideChanges}
                    remember={false}
                    testId={`mission-version-${version.number}-changes`}
                  >
                    <ul className={styles.versionChanges}>
                      {version.details.map((line) => (
                        <li key={line}>{line}</li>
                      ))}
                    </ul>
                  </Disclosure>
                )}
              </>
            }
            end={
              version.current ? (
                <Tag>{MISSION_HISTORY.current}</Tag>
              ) : restorable ? (
                <Button
                  size="sm"
                  loading={busy && restoring === version.number}
                  disabled={busy}
                  onClick={() => void restore(version.number)}
                  data-testid={`restore-version-${version.number}`}
                >
                  {MISSION_HISTORY.restore}
                </Button>
              ) : undefined
            }
          />
        ))}
      </Rows>
    </>
  );
}
