/**
 * Host-agnostic HTTP handlers of the Missions surface (`Request → Response`,
 * never `next`). The Next route handlers under `src/app/api/missions/**` are
 * one-line adapters over these.
 *
 *   POST /api/missions/preview        what a draft would yield (writes nothing)
 *   POST /api/missions                issue; the token secret is in this response only
 *   POST /api/missions/:id/rotate     new token, same mission
 *   POST /api/missions/:id/revoke     the mission refuses everything from now on (the
 *                                     creator; or, while it is orphaned, an owner of one
 *                                     of its connections)
 *   POST /api/missions/:id/gate       `{ risk_id, gate }`: the gate of one accepted risk
 *   POST /api/missions/:id/limits     `{ limits: [{ risk_id, quota, rate_limit: { max } }] }`:
 *                                     the limits of accepted risks (creator only)
 *
 * Every one is a mutation or reveals a secret: valid user session, origin
 * check, `Cache-Control: no-store` (spec §6). A mission always has an
 * identified human behind it, so the bootstrap operator cannot issue one.
 */
import { guardMutation, refusalResponse, type Authenticator, type UserPrincipal } from '../auth';
import { parseMissionDraft } from './draft-schema';
import type { LimitEdit, MissionService } from './mission-service';
import type { MissionDraft } from './model';

export interface MissionHandlerDeps {
  readonly publicUrl: URL;
  readonly authenticator: Authenticator;
  readonly service: MissionService;
}

export interface MissionHandlers {
  changePermissions(request: Request, missionId: string): Promise<Response>;
  preview(request: Request): Promise<Response>;
  issue(request: Request): Promise<Response>;
  rotate(request: Request, missionId: string): Promise<Response>;
  revoke(request: Request, missionId: string): Promise<Response>;
  /** `POST /api/missions/:id/gate` — body `{ risk_id, gate: 'auto' | 'approval' }`. */
  setGate(request: Request, missionId: string): Promise<Response>;
  /**
   * `POST /api/missions/:id/limits` — body `{ limits: [{ risk_id, quota, rate_limit:
   * { max } }] }`: the new quota and calls per rate window of risks the mission holds.
   */
  setLimits(request: Request, missionId: string): Promise<Response>;
}

const INVALID_LIMITS_EDIT = {
  error: 'invalid-limits-edit',
  message:
    'The body is { "limits": [{ "risk_id": string, "quota": number, "rate_limit": { "max": number } }] }, with at least one permission.',
};

/** Largest number a limit may be written as: past it, a JSON number is no longer exact. */
const LARGEST_LIMIT = Number.MAX_SAFE_INTEGER;

/** One line of a limits edit, or `null` when it is not one. */
function limitLineOf(raw: unknown): LimitEdit | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const { risk_id: riskId, quota, rate_limit: rate, ...extra } = raw as Record<string, unknown>;
  if (Object.keys(extra).length > 0) return null;
  if (typeof riskId !== 'string' || typeof quota !== 'number') return null;
  if (typeof rate !== 'object' || rate === null || Array.isArray(rate)) return null;
  const { max, ...rateExtra } = rate as Record<string, unknown>;
  // The window is the mission's: it is not part of a change, and naming it is refused.
  if (Object.keys(rateExtra).length > 0 || typeof max !== 'number') return null;
  if (Math.abs(quota) > LARGEST_LIMIT || Math.abs(max) > LARGEST_LIMIT) return null;
  return { risk_id: riskId, quota, rate_limit_max: max };
}

/** The lines of a limits edit, or `null` when the body is not one. */
async function limitsEditOf(request: Request): Promise<LimitEdit[] | null> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const { limits, ...extra } = raw as Record<string, unknown>;
  if (Object.keys(extra).length > 0 || !Array.isArray(limits) || limits.length === 0) return null;
  const lines: LimitEdit[] = [];
  for (const item of limits) {
    const line = limitLineOf(item);
    if (!line) return null;
    lines.push(line);
  }
  return lines;
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
  forbidden: 'A mission is created by an identified person; sign in through the identity provider.',
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
    async changePermissions(request, missionId) {
      const principal = await userOf(request);
      if (principal instanceof Response) return principal;
      const raw: unknown = await request.json().catch(() => null);
      const result = await deps.service.changePermissions(principal.user, missionId, raw);
      if (result.ok) return json(200, { mission: { id: result.mission.id } });
      return json(
        result.reason === 'not-found'
          ? 404
          : result.reason === 'conflict' || result.reason === 'inactive'
            ? 409
            : 422,
        { error: result.reason, ...('issues' in result ? { issues: result.issues } : {}) },
      );
    },
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
        message: `The mission is ${result.state}; its key cannot be replaced.`,
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
          opening_closed: result.opening_closed,
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
            message: `The mission does not hold the permission '${edit.riskId}': “ask me first” is set on a permission the mission holds.`,
          });
        case 'inactive':
          return json(409, {
            error: 'mission-inactive',
            message: `The mission is ${result.state}; every call is refused, whether or not a permission asks first.`,
          });
      }
    },

    async setLimits(request, missionId) {
      const principal = await userOf(request);
      if (principal instanceof Response) return principal;
      const edits = await limitsEditOf(request);
      if (!edits) return json(400, INVALID_LIMITS_EDIT);
      const result = await deps.service.setLimits(principal.user, missionId, edits);
      if (result.ok) {
        return json(200, { mission: { id: result.mission.id }, changed: result.changed });
      }
      switch (result.reason) {
        case 'not-found':
          return json(404, NOT_FOUND);
        case 'invalid-limits':
          return json(400, { ...INVALID_LIMITS_EDIT, message: result.problem });
        case 'risk-not-in-policy':
          return json(422, {
            error: 'risk-not-in-policy',
            risk_ids: result.risk_ids,
            message: `The mission does not hold ${result.risk_ids.join(', ')}: limits are changed on the permissions a mission holds. To add or remove one, create a mission or duplicate this one.`,
          });
        case 'refused':
          return json(422, {
            error: 'refused',
            issues: result.issues,
            message: result.issues.map((issue) => issue.message).join(' '),
          });
        case 'inactive':
          return json(409, {
            error: 'mission-inactive',
            message: `The mission is ${result.state}; its limits are not changed.`,
          });
      }
    },
  };
}
