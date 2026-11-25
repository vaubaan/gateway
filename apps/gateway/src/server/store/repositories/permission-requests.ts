import { withImmediateTransaction } from '../db.ts';
import { nowIso, type RepoContext } from './context.ts';
import type { RequestLine } from '../types.ts';
import { insertRequestSync, setRisksJsonOf } from './requests.ts';
import { createMissionLogPrimitives } from './mission-logs.ts';

export interface PermissionRefusalInput {
  readonly missionId: string;
  readonly tokenId: string;
  readonly holder: string;
  readonly tool: string;
  readonly fingerprint: string;
  readonly riskIds: readonly string[];
  /** The (set, risk) lines found missing: each missing risk in each set the call was judged against. */
  readonly lines: readonly RequestLine[];
}
export interface PermissionRequestDetails {
  readonly holder: string;
  readonly tokenId: string;
  readonly reason: string;
}
export type AskPermissionResult =
  | { readonly ok: true; readonly requestId: string; readonly created: boolean }
  | { readonly ok: false; readonly reason: 'invalid-refusal' | 'rate-limited' };

interface EvidenceRow {
  id: string;
  mission_id: string;
  token_id: string;
  holder: string;
  tool: string;
  fingerprint: string;
  risk_ids_json: string;
  expires_at: string;
  request_id: string | null;
}

/** Persistent refusal references; recording one never opens an inbox request. */
export function createPermissionRequests(ctx: RepoContext) {
  const { db } = ctx;
  return {
    async recordPermissionRefusal(input: PermissionRefusalInput): Promise<string> {
      const id = ctx.newId();
      const now = nowIso(ctx);
      const expires = new Date(Date.parse(now) + 15 * 60_000).toISOString();
      db.prepare(
        `INSERT INTO permission_refusals
        (id, mission_id, token_id, holder, tool, fingerprint, risk_ids_json, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        input.missionId,
        input.tokenId,
        input.holder,
        input.tool,
        input.fingerprint,
        JSON.stringify([...new Set(input.riskIds)].sort()),
        now,
        expires,
      );
      const line = db.prepare(
        `INSERT INTO permission_refusal_lines (refusal_id, resource_set_id, risk_id)
         VALUES (?, ?, ?) ON CONFLICT DO NOTHING`,
      );
      for (const l of input.lines) line.run(id, l.resourceSetId, l.riskId);
      return id;
    },
    async permissionDetails(requestId: string): Promise<PermissionRequestDetails | null> {
      return (
        db
          .prepare<[string], PermissionRequestDetails>(
            'SELECT holder, token_id AS tokenId, reason FROM permission_requests WHERE request_id = ?',
          )
          .get(requestId) ?? null
      );
    },
    async askPermission(input: {
      refusalId: string;
      missionId: string;
      tokenId: string;
      reason: string;
      expirySeconds: number;
    }): Promise<AskPermissionResult> {
      return withImmediateTransaction(db, () => {
        const now = nowIso(ctx);
        const row = db
          .prepare<[string], EvidenceRow>('SELECT * FROM permission_refusals WHERE id = ?')
          .get(input.refusalId);
        if (!row || row.mission_id !== input.missionId || row.token_id !== input.tokenId) {
          return { ok: false, reason: 'invalid-refusal' };
        }
        if (row.request_id) return { ok: true, requestId: row.request_id, created: false };
        if (row.expires_at <= now) return { ok: false, reason: 'invalid-refusal' };
        const lines: RequestLine[] = db
          .prepare<[string], { resource_set_id: string; risk_id: string }>(
            `SELECT resource_set_id, risk_id FROM permission_refusal_lines
             WHERE refusal_id = ? ORDER BY resource_set_id, risk_id`,
          )
          .all(row.id)
          .map((l) => ({ resourceSetId: l.resource_set_id, riskId: l.risk_id }));
        // What makes two refusals the same ask: their lines (sets and risks), else their risks.
        const riskSet = lines.length > 0 ? setRisksJsonOf(lines) : row.risk_ids_json;
        const existing = db
          .prepare<[string, string, string, string], { id: string }>(
            `SELECT r.id FROM requests r JOIN permission_requests p ON p.request_id = r.id
           WHERE r.mission_id = ? AND p.holder = ? AND p.risk_set = ?
           AND r.state = 'open' AND r.expires_at > ? ORDER BY r.created_at LIMIT 1`,
          )
          .get(input.missionId, row.holder, riskSet, now);
        let requestId = existing?.id;
        if (!requestId) {
          const since = new Date(Date.parse(now) - 24 * 60 * 60_000).toISOString();
          const count =
            db
              .prepare<[string, string], { n: number }>(
                "SELECT count(*) AS n FROM requests WHERE mission_id = ? AND kind = 'permission' AND created_at > ?",
              )
              .get(input.missionId, since)?.n ?? 0;
          if (count >= 10) return { ok: false, reason: 'rate-limited' };
          const risks = JSON.parse(row.risk_ids_json) as string[];
          const first = risks[0];
          if (!first) return { ok: false, reason: 'invalid-refusal' };
          const missionLog = db
            .prepare<[string], { id: string }>('SELECT id FROM mission_logs WHERE mission_id = ?')
            .get(input.missionId);
          const request = insertRequestSync(
            ctx,
            {
              missionId: input.missionId,
              missionLogId: missionLog?.id ?? null,
              kind: 'permission',
              riskId: first,
              riskIds: risks,
              // A refusal recorded with no line (before 0029): each risk in its one set.
              ...(lines.length > 0 ? { lines } : {}),
              tool: row.tool,
              fingerprint: row.fingerprint,
              expiresAt: new Date(Date.parse(now) + input.expirySeconds * 1000).toISOString(),
            },
            now,
          );
          requestId = request.id;
          if (missionLog)
            createMissionLogPrimitives(ctx).recordEvent(
              missionLog.id,
              {
                kind: 'request',
                riskId: first,
                resourceSetId: request.lines[0]?.resourceSetId ?? null,
                details: {
                  request_id: requestId,
                  request_kind: 'permission',
                  tool: row.tool,
                  fingerprint: row.fingerprint,
                },
              },
              now,
            );
          db.prepare(
            'INSERT INTO permission_requests (request_id, holder, token_id, reason, risk_set) VALUES (?, ?, ?, ?, ?)',
          ).run(requestId, row.holder, row.token_id, input.reason, riskSet);
        }
        db.prepare('UPDATE permission_refusals SET request_id = ? WHERE id = ?').run(
          requestId,
          row.id,
        );
        return { ok: true, requestId, created: !existing };
      });
    },
  };
}
export type PermissionRequestsRepo = ReturnType<typeof createPermissionRequests>;
