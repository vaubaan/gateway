'use client';

/**
 * "People and keys" of a mission (spec §4.2 "Missions", §7.9 bis): who works
 * on it, each with one key, and what that key did in the current period.
 *
 * One row per holder — the creator, then the teammates in the order they were
 * added, then the machine keys. Three things by default (who, what their key
 * did, the acts on the row); the role and the masked key are details.
 *
 *   the creator   replaces their own key, removes a teammate, revokes or
 *                 replaces any other key;
 *   a teammate    generates and replaces their OWN key, and reads the rest.
 *
 * A row shows an act only when the server would take it. A key is never shown
 * here beyond its masked form: it was shown once, to the person who made it.
 */
import {
  Button,
  DataTable,
  DetailScope,
  DetailToggle,
  KeyHolder,
  KeyMark,
  Section,
  type Column,
} from '@/components/ui';
import {
  ACTIONS,
  agoSentence,
  count,
  KEY_WORDS,
  MISSION_ACTIONS,
  MISSION_WORDS,
  qualifiers,
  ROLE_WORDS,
  SECTIONS,
  shortDate,
  TERMS,
} from '@/lib/vocabulary';
import type { MissionTeam, TeamMemberView, TeamTokenView } from '@/server/missions/team-service';

import styles from '../missions.module.css';
import { useMissionActs } from './mission-actions';

/** The calls of the current period made with the keys of one holder. */
export interface HolderCalls {
  /** `member` with a user id, or `named` with the name of a machine key. */
  readonly kind: 'member' | 'named';
  readonly key: string;
  readonly allowed: number;
  readonly refused: number;
  readonly last_seen_at: string;
}

interface HolderRow {
  readonly id: string;
  readonly name: string;
  readonly machine: boolean;
  readonly member: TeamMemberView | null;
  readonly token: TeamTokenView | null;
  readonly calls: HolderCalls | null;
  readonly mine: boolean;
}

function masked(prefix: string): string {
  return `vbn_live_${prefix}_…`;
}

function rowsOf(team: MissionTeam, calls: readonly HolderCalls[]): HolderRow[] {
  const people = team.members.map((member): HolderRow => {
    const token =
      team.tokens.find((t) => t.holder.kind === 'member' && t.holder.user_id === member.user_id) ??
      null;
    return {
      id: `member:${member.email}`,
      name: member.email,
      machine: false,
      member,
      token,
      calls: calls.find((c) => c.kind === 'member' && c.key === member.user_id) ?? null,
      mine: false,
    };
  });
  const machines = team.tokens
    .filter((token) => token.holder.kind === 'named')
    .map(
      (token): HolderRow => ({
        id: `machine:${token.holder.label}`,
        name: token.holder.label,
        machine: true,
        member: null,
        token,
        calls: calls.find((c) => c.kind === 'named' && c.key === token.holder.label) ?? null,
        mine: false,
      }),
    );
  return [...people, ...machines];
}

export function TeamSection({
  team,
  calls,
  period,
  me,
  now,
}: {
  team: MissionTeam;
  calls: readonly HolderCalls[];
  /** "today", "this week": the period the calls are counted in. */
  period: string;
  /** The reader's user id: their own row is the one they act on. */
  me: string;
  /** The instant the page was rendered at, so that "2 min" reads the same on both sides. */
  now: string;
}) {
  const acts = useMissionActs();
  const isCreator = team.role === 'creator';
  const at = new Date(now);
  const rows = rowsOf(team, calls).map((row) => ({
    ...row,
    mine: row.member?.user_id === me,
  }));

  const columns: Column<HolderRow>[] = [
    {
      id: 'holder',
      header: 'Holder',
      // The same place on every mission, whatever the names: the eye finds the second column.
      width: '40%',
      cell: (row) => (
        <KeyHolder
          name={row.name}
          kind={row.machine ? 'machine' : 'person'}
          muted={row.member ? !row.member.active : false}
          qualifier={qualifiers([
            row.mine && ROLE_WORDS.you,
            row.member?.role === 'creator' && ROLE_WORDS.creator,
            row.machine && KEY_WORDS.machineKey,
            row.member && !row.member.active && 'no longer active',
          ])}
        />
      ),
    },
    {
      id: 'calls',
      header: 'Calls',
      cell: (row) => {
        if (!row.token) {
          return (
            <span className={styles.quietText}>
              {team.issuable ? KEY_WORDS.notGenerated : 'no working key'}
            </span>
          );
        }
        if (row.calls) {
          const total = row.calls.allowed + row.calls.refused;
          return (
            <span className={styles.quietText}>
              {count(total, TERMS.call)} {period}
              {row.calls.refused > 0 && ` · ${row.calls.refused} refused`} · last call{' '}
              {agoSentence(row.calls.last_seen_at, at)}
            </span>
          );
        }
        return (
          <span className={styles.quietText}>
            {row.token.last_used_at
              ? `no call ${period} · last used ${agoSentence(row.token.last_used_at, at)}`
              : 'key never used'}
          </span>
        );
      },
    },
    {
      id: 'role',
      header: 'Role',
      detail: true,
      cell: (row) => {
        if (row.machine) {
          return (
            <>
              Machine key
              <span className={styles.sub}>
                created by {row.token?.created_by}
                {row.token && ` · ${shortDate(row.token.created_at, at)}`}
              </span>
            </>
          );
        }
        if (row.member?.role === 'creator') {
          return (
            <>
              Creator<span className={styles.sub}>answers what agents ask</span>
            </>
          );
        }
        return (
          <>
            Teammate
            {row.member?.added_at && (
              <span className={styles.sub}>added {shortDate(row.member.added_at, at)}</span>
            )}
          </>
        );
      },
    },
    {
      id: 'key',
      header: 'Key',
      detail: true,
      nowrap: true,
      cell: (row) =>
        row.token ? (
          <>
            <KeyMark>{masked(row.token.prefix)}</KeyMark>
            <span className={styles.sub}>
              issued {shortDate(row.token.created_at, at)} · {KEY_WORDS.shownOnce.toLowerCase()}
            </span>
          </>
        ) : (
          '—'
        ),
    },
  ];

  function actionsOf(row: HolderRow): React.ReactNode {
    const { token, member } = row;
    if (row.mine) {
      if (!token) {
        return team.issuable ? (
          <Button type="button" size="sm" disabled={acts.busy} onClick={acts.generateMine}>
            {MISSION_ACTIONS.generateKey}
          </Button>
        ) : null;
      }
      return (
        <span className={styles.rowActions}>
          <Button type="button" size="sm" onClick={() => acts.open({ kind: 'kit' })}>
            Kit
          </Button>
          {team.issuable && (
            <Button
              type="button"
              size="sm"
              aria-label="Replace my key"
              onClick={() => acts.open({ kind: 'replace-mine' })}
            >
              {ACTIONS.replaceKey}
            </Button>
          )}
        </span>
      );
    }
    if (!isCreator) return null;
    if (row.machine && token) {
      return (
        <span className={styles.rowActions}>
          {team.issuable && (
            <Button
              type="button"
              size="sm"
              aria-label={`Replace the machine key ${row.name}`}
              onClick={() => acts.open({ kind: 'replace-machine', token })}
            >
              {ACTIONS.replaceKey}
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            variant="danger"
            aria-label={`Revoke the machine key ${row.name}`}
            onClick={() => acts.open({ kind: 'revoke-key', token })}
          >
            {ACTIONS.revokeKey}
          </Button>
        </span>
      );
    }
    if (member && member.role === 'member') {
      return (
        <span className={styles.rowActions}>
          {token?.revocable && (
            <Button
              type="button"
              size="sm"
              variant="danger"
              aria-label={`Revoke the key of ${row.name}`}
              onClick={() => acts.open({ kind: 'revoke-key', token })}
            >
              Revoke key
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            variant="danger"
            aria-label={`Remove ${row.name}`}
            onClick={() =>
              acts.open({ kind: 'remove-teammate', userId: member.user_id, email: member.email })
            }
          >
            {MISSION_ACTIONS.removeTeammate}
          </Button>
        </span>
      );
    }
    return null;
  }

  return (
    <DetailScope id={`mission:${team.mission.id}:people`}>
      <Section
        id="people"
        title={SECTIONS.peopleAndKeys}
        count={rows.length}
        note={
          <>
            <span className={styles.noteText}>{MISSION_WORDS.sameForEveryone}</span>
            <DetailToggle />
          </>
        }
        testId="team-section"
      >
        <DataTable
          caption="People and keys of this mission"
          columns={columns}
          rows={rows}
          rowKey={(row) => row.id}
          actions={actionsOf}
          headless
          testId="team-table"
        />
        {team.tokens.length === 0 && (
          <p className={styles.quiet} data-testid="no-key-works">
            {MISSION_WORDS.noKeyWorks}
          </p>
        )}
      </Section>
    </DetailScope>
  );
}
