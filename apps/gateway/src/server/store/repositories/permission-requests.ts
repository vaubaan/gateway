import { withImmediateTransaction } from '../db.ts';
import { nowIso, type RepoContext } from './context.ts';
import { insertRequestSync } from './requests.ts';
import { createSessionPrimitives } from './sessions.ts';

export interface PermissionRefusalInput {
  readonly missionId: string;
  readonly tokenId: string;
  readonly holder: string;
  readonly tool: string;
  readonly fingerprint: string;
  readonly riskIds: readonly string[];
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
      return id;
    },
    async permissionDetails(requestId: string): Promise<PermissionRequestDetails | null> {
      return (
        db
          .prepare<
            [string],
            PermissionRequestDetails
          >('SELECT holder, token_id AS tokenId, reason FROM permission_requests WHERE request_id = ?')
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
        const existing = db
          .prepare<[string, string, string, string], { id: string }>(
            `SELECT r.id FROM requests r JOIN permission_requests p ON p.request_id = r.id
           WHERE r.mission_id = ? AND p.holder = ? AND p.risk_set = ?
           AND r.state = 'open' AND r.expires_at > ? ORDER BY r.created_at LIMIT 1`,
          )
          .get(input.missionId, row.holder, row.risk_ids_json, now);
        let requestId = existing?.id;
        if (!requestId) {
          const since = new Date(Date.parse(now) - 24 * 60 * 60_000).toISOString();
          const count =
            db
              .prepare<
                [string, string],
                { n: number }
              >("SELECT count(*) AS n FROM requests WHERE mission_id = ? AND kind = 'permission' AND created_at > ?")
              .get(input.missionId, since)?.n ?? 0;
          if (count >= 10) return { ok: false, reason: 'rate-limited' };
          const risks = JSON.parse(row.risk_ids_json) as string[];
          const first = risks[0];
          if (!first) return { ok: false, reason: 'invalid-refusal' };
          const session = db
            .prepare<[string], { id: string }>('SELECT id FROM sessions WHERE mission_id = ?')
            .get(input.missionId);
          const request = insertRequestSync(
            ctx,
            {
              missionId: input.missionId,
              sessionId: session?.id ?? null,
              kind: 'permission',
              riskId: first,
              riskIds: risks,
              tool: row.tool,
              fingerprint: row.fingerprint,
              expiresAt: new Date(Date.parse(now) + input.expirySeconds * 1000).toISOString(),
            },
            now,
          );
          requestId = request.id;
          if (session)
            createSessionPrimitives(ctx).recordEvent(
              session.id,
              {
                kind: 'request',
                riskId: first,
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
          ).run(requestId, row.holder, row.token_id, input.reason, row.risk_ids_json);
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
