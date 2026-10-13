/**
 * Host-agnostic HTTP handlers of the Missions surface (`Request → Response`,
 * never `next`). The Next route handlers under `src/app/api/missions/**` are
 * one-line adapters over these.
 *
 *   POST /api/missions/preview        what a draft would yield (writes nothing)
 *   POST /api/missions                issue; the token secret is in this response only
 *   POST /api/missions/:id/rotate     new token, same mission
 *   POST /api/missions/:id/revoke     the mission refuses everything from now on
 *   POST /api/missions/:id/gate       `{ risk_id, gate }`: the gate of one accepted risk
 *
 * Every one is a mutation or reveals a secret: valid user session, origin
 * check, `Cache-Control: no-store` (spec §6). A mission always has an
 * identified human behind it, so the bootstrap operator cannot issue one.
 */
import { guardMutation, refusalResponse, type Authenticator, type UserPrincipal } from '../auth';
import { parseMissionDraft } from './draft-schema';
import type { MissionService } from './mission-service';
import type { MissionDraft } from './model';

export interface MissionHandlerDeps {
  readonly publicUrl: URL;
  readonly authenticator: Authenticator;
  readonly service: MissionService;
}

export interface MissionHandlers {
  preview(request: Request): Promise<Response>;
  issue(request: Request): Promise<Response>;
  rotate(request: Request, missionId: string): Promise<Response>;
  revoke(request: Request, missionId: string): Promise<Response>;
  /** `POST /api/missions/:id/gate` — body `{ risk_id, gate: 'auto' | 'approval' }`. */
  setGate(request: Request, missionId: string): Promise<Response>;
}

const INVALID_GATE_EDIT = {
  error: 'invalid-gate-edit',
  message: 'The body is { "risk_id": string, "gate": "auto" | "approval" }.',
};

/** The two fields of a gate edit, or `null` when the body is not one. */
async function gateEditOf(request: Request): Promise<{ riskId: string; gate: string } | null> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const { risk_id: riskId, gate, ...extra } = raw as Record<string, unknown>;
  if (typeof riskId !== 'string' || typeof gate !== 'string') return null;
  if (Object.keys(extra).length > 0) return null;
  return { riskId, gate };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

const REFUSALS = {
  field: 'message',
  noSession: 'Sign in first.',
  forbidden: 'A mission is issued by an identified user; sign in through the identity provider.',
} as const;

const NOT_FOUND = { error: 'not-found', message: 'No such mission among yours.' };

export function createMissionHandlers(deps: MissionHandlerDeps): MissionHandlers {
  /** The signed-in user behind a mutation, or the response that refuses it. */
  async function userOf(request: Request): Promise<UserPrincipal | Response> {
    const guard = await guardMutation(request, deps, 'user');
    return guard.ok ? guard.principal : refusalResponse(guard, REFUSALS);
  }

  async function draftOf(request: Request): Promise<MissionDraft | Response> {
    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return json(400, { error: 'invalid-draft', problems: ['the body is not JSON'] });
    }
    const parsed = parseMissionDraft(raw);
    if (!parsed.ok) return json(400, { error: 'invalid-draft', problems: parsed.problems });
    return parsed.draft;
  }

  return {
    async preview(request) {
      const principal = await userOf(request);
      if (principal instanceof Response) return principal;
      const draft = await draftOf(request);
      if (draft instanceof Response) return draft;
      return json(200, { preview: await deps.service.preview(principal.user, draft) });
    },

    async issue(request) {
      const principal = await userOf(request);
      if (principal instanceof Response) return principal;
      const draft = await draftOf(request);
      if (draft instanceof Response) return draft;
      const result = await deps.service.issue(principal.user, draft);
      if (!result.ok) {
        if (result.reason === 'not-found') return json(404, NOT_FOUND);
        return json(422, { error: 'refused', preview: result.preview });
      }
      return json(201, {
        mission: { id: result.mission.id, name: result.mission.name },
        token: result.token,
        kit: result.kit,
      });
    },

    async rotate(request, missionId) {
      const principal = await userOf(request);
      if (principal instanceof Response) return principal;
      const result = await deps.service.rotate(principal.user, missionId);
      if (result.ok) {
        return json(200, {
          mission: { id: result.mission.id, name: result.mission.name },
          token: result.token,
          kit: result.kit,
        });
      }
      // `not-issued-by-delegation` is the management door's refusal: no delegation asks
      // here, so the service never answers it; were it to, the mission is not the caller's.
      if (result.reason !== 'inactive') return json(404, NOT_FOUND);
      return json(409, {
        error: 'mission-inactive',
        message: `The mission is ${result.state}; its token cannot be rotated.`,
      });
    },

    async revoke(request, missionId) {
      const principal = await userOf(request);
      if (principal instanceof Response) return principal;
      const result = await deps.service.revoke(principal.user, missionId);
      if (!result.ok) return json(404, NOT_FOUND);
      return json(200, { mission: { id: result.mission.id, status: result.mission.status } });
    },

    async setGate(request, missionId) {
      const principal = await userOf(request);
      if (principal instanceof Response) return principal;
      const edit = await gateEditOf(request);
      if (!edit) return json(400, INVALID_GATE_EDIT);
      const result = await deps.service.setGate(principal.user, missionId, edit.riskId, edit.gate);
      if (result.ok) {
        return json(200, {
          mission: { id: result.mission.id },
          risk_id: result.risk_id,
          gate: result.gate,
          previous: result.previous,
        });
      }
      switch (result.reason) {
        case 'not-found':
          return json(404, NOT_FOUND);
        case 'invalid-gate':
          return json(400, INVALID_GATE_EDIT);
        case 'risk-not-in-policy':
          return json(422, {
            error: 'risk-not-in-policy',
            message: `The mission does not accept '${edit.riskId}': a gate is set on an accepted risk.`,
          });
        case 'inactive':
          return json(409, {
            error: 'mission-inactive',
            message: `The mission is ${result.state}; every call is refused whatever its gates.`,
          });
      }
    },
  };
}
