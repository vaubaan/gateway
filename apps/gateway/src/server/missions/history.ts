/**
 * The history of a mission's configuration as its page reads it (spec §4.2 "History"):
 * one row per version, newest first, with who, when, why, the compact clauses of what
 * moved (`missionChangeClauses`, the words of the activity's `mission-changed`) and the
 * detail lines of what differs from the previous version (`versionDetailLines`).
 *
 * Built from the store's records and the names the service looked up: no IO here, and
 * no store record leaves (snake_case views only).
 */
import type { Iso8601, RiskId } from '@vaubaan/shared';

import { missionChangeClauses } from '../../lib/missions/change-words';
import type { PreviewIssue } from '../../lib/missions/model';
import {
  changesBetween,
  versionDetailLines,
  type AccountNames,
  type MissionVersionAuthorKind,
  type MissionVersionCause,
} from '../../lib/missions/versions';
import type { LimitReachedResult } from './mission-service';
import type { MissionRecord, MissionVersionRecord } from '../store/types';

/** Who wrote a version, named for the page. */
export interface MissionVersionAuthorView {
  readonly kind: MissionVersionAuthorKind;
  /** A person's address, a mission's name, or "the gateway". */
  readonly label: string;
  /** The mission whose agent made the change through its Vaubaan account; `null` otherwise. */
  readonly mission_id: string | null;
}

export interface MissionVersionView {
  readonly number: number;
  readonly created_at: Iso8601;
  readonly cause: MissionVersionCause;
  /** The version a rollback restored; `null` for any other cause. */
  readonly restored_from: number | null;
  readonly author: MissionVersionAuthorView;
  /** "2 resources added", "quota of github.read 200 → 500"…; empty for a first version. */
  readonly clauses: readonly string[];
  /** What differs from the previous version, line by line; empty for a first version. */
  readonly details: readonly string[];
  /** The configuration the mission has now. */
  readonly current: boolean;
}

export interface MissionHistoryView {
  /** Newest first. */
  readonly versions: readonly MissionVersionView[];
  /** The reader may restore a past version now (the creator, on an editable mission). */
  readonly restorable: boolean;
}

/** The names the history is worded with, looked up by the service. */
export interface HistoryWords {
  readonly personOf: (userId: string) => string;
  readonly missionOf: (missionId: string) => string;
  readonly accountOf: (accountId: string) => AccountNames | undefined;
  readonly resourceName: (accountId: string, resourceId: string) => string;
  readonly riskLabel: (riskId: RiskId) => string;
}

/** The label the page gives the gateway when it wrote a version itself. */
export const GATEWAY_AUTHOR = 'the gateway';

function authorViewOf(record: MissionVersionRecord, words: HistoryWords): MissionVersionAuthorView {
  const author = record.author;
  switch (author.kind) {
    case 'person':
      return { kind: 'person', label: words.personOf(author.userId), mission_id: null };
    case 'mission':
      return {
        kind: 'mission',
        label: words.missionOf(author.missionId),
        mission_id: author.missionId,
      };
    case 'gateway':
      return { kind: 'gateway', label: GATEWAY_AUTHOR, mission_id: null };
  }
}

/** The history view of `records` (newest first, as the store lists them). */
export function historyViewOf(
  records: readonly MissionVersionRecord[],
  words: HistoryWords,
  options: { readonly restorable: boolean },
): MissionHistoryView {
  const versions = records.map((record, index): MissionVersionView => {
    const previous = records[index + 1];
    return {
      number: record.number,
      created_at: record.createdAt,
      cause: record.cause,
      restored_from: record.restoredFrom,
      author: authorViewOf(record, words),
      clauses: record.changes ? missionChangeClauses(record.changes) : [],
      details: previous
        ? versionDetailLines(changesBetween(previous.config, record.config, words.accountOf), words)
        : [],
      current: index === 0,
    };
  });
  return { versions, restorable: options.restorable };
}

/** What "Restore this version" did, or why it did not. */
export type RestoreResult =
  | {
      readonly ok: true;
      readonly mission: MissionRecord;
      /** The version the restore wrote; `null` when that configuration was already the mission's. */
      readonly version: number | null;
      readonly restored_from: number;
      /** What could not be restored, in sentences: authority lost, resources gone, an end passed. */
      readonly dropped: readonly string[];
    }
  | { readonly ok: false; readonly reason: 'not-found' }
  | { readonly ok: false; readonly reason: 'inactive'; readonly state: 'revoked' | 'orphaned' }
  | { readonly ok: false; readonly reason: 'invalid-edit'; readonly problems: readonly string[] }
  /** The mission changed while the restore was written: nothing was written. */
  | { readonly ok: false; readonly reason: 'conflict' }
  /** What issuance refuses in the restored configuration, beyond what was left out. */
  | {
      readonly ok: false;
      readonly reason: 'refused';
      readonly issues: readonly PreviewIssue[];
      readonly dropped: readonly string[];
    }
  | LimitReachedResult;
