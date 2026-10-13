/**
 * Host-agnostic HTTP handlers of a mission's members and tokens (`Request →
 * Response`, never `next`). The Next route handlers under
 * `src/app/api/missions/[id]/{members,tokens}/**` are one-line adapters.
 *
 *   POST /api/missions/:id/members                  `{ email }` — the creator adds a member
 *   POST /api/missions/:id/members/:userId/remove   the creator removes one (their token is revoked)
 *   POST /api/missions/:id/tokens/mine              the caller generates or rotates their OWN token
 *   POST /api/missions/:id/tokens                   `{ name }` — the creator creates a named token
 *   POST /api/missions/:id/tokens/:tokenId/revoke   the holder, or the creator, revokes one token
 *
 * Every one is a mutation, and two reveal a secret: valid user session, origin
 * check, `Cache-Control: no-store` (spec §6). The secret of a token is in the
 * answer of the request that generated it and nowhere else: `tokens/mine`
 * answers the member who asked, never the creator.
 */
import { guardMutation, refusalResponse, type Authenticator, type UserPrincipal } from '../auth';
import type { IssuedTokenResult, MissionTeamService } from './team-service';

export interface TeamHandlerDeps {
  readonly publicUrl: URL;
  readonly authenticator: Authenticator;
  readonly team: MissionTeamService;
}

export interface TeamHandlers {
  addMember(request: Request, missionId: string): Promise<Response>;
  removeMember(request: Request, missionId: string, userId: string): Promise<Response>;
  generateToken(request: Request, missionId: string): Promise<Response>;
  createNamedToken(request: Request, missionId: string): Promise<Response>;
  revokeToken(request: Request, missionId: string, tokenId: string): Promise<Response>;
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
  forbidden: 'A mission is worked on by identified users; sign in through the identity provider.',
} as const;

const NOT_FOUND = { error: 'not-found', message: 'No such mission, member or token among yours.' };

/** One string field of a JSON body and nothing else; `null` when the body is not that. */
async function fieldOf(request: Request, name: string): Promise<string | null> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const { [name]: value, ...extra } = raw as Record<string, unknown>;
  if (typeof value !== 'string' || Object.keys(extra).length > 0) return null;
  return value;
}

function inactive(state: string): Response {
  return json(409, {
    error: 'mission-inactive',
    message: `The mission is ${state}; no token can be generated for it and nobody can be added to it.`,
  });
}

/** The answer that carries a secret, once. */
function revealed(status: number, result: Extract<IssuedTokenResult, { ok: true }>): Response {
  return json(status, {
    mission: result.mission,
    token: result.token,
    kit: result.kit,
    rotated: result.rotated,
  });
}

export function createTeamHandlers(deps: TeamHandlerDeps): TeamHandlers {
  /** The signed-in user behind a mutation, or the response that refuses it. */
  async function userOf(request: Request): Promise<UserPrincipal | Response> {
    const guard = await guardMutation(request, deps, 'user');
    return guard.ok ? guard.principal : refusalResponse(guard, REFUSALS);
  }

  return {
    async addMember(request, missionId) {
      const principal = await userOf(request);
      if (principal instanceof Response) return principal;
      const email = await fieldOf(request, 'email');
      if (email === null) {
        return json(400, { error: 'invalid-member', message: 'The body is { "email": string }.' });
      }
      const result = await deps.team.addMember(principal.user, missionId, { email });
      if (result.ok) return json(201, { member: result.member });
      switch (result.reason) {
        case 'not-found':
          return json(404, NOT_FOUND);
        case 'inactive':
          return inactive(result.state);
        case 'user-not-found':
          return json(422, {
            error: 'user-not-found',
            message:
              'No active user of this instance has this email. A user exists here once they have signed in.',
          });
        case 'already-member':
          return json(409, {
            error: 'already-member',
            message: 'This user is already on the mission.',
          });
      }
    },

    async removeMember(request, missionId, userId) {
      const principal = await userOf(request);
      if (principal instanceof Response) return principal;
      const result = await deps.team.removeMember(principal.user, missionId, userId);
      if (!result.ok) return json(404, NOT_FOUND);
      return json(200, { user_id: result.user_id, token_revoked: result.token_revoked });
    },

    async generateToken(request, missionId) {
      const principal = await userOf(request);
      if (principal instanceof Response) return principal;
      const result = await deps.team.generateToken(principal.user, missionId);
      if (result.ok) return revealed(200, result);
      return result.reason === 'inactive' ? inactive(result.state) : json(404, NOT_FOUND);
    },

    async createNamedToken(request, missionId) {
      const principal = await userOf(request);
      if (principal instanceof Response) return principal;
      const name = await fieldOf(request, 'name');
      if (name === null) {
        return json(400, { error: 'invalid-name', message: 'The body is { "name": string }.' });
      }
      const result = await deps.team.createNamedToken(principal.user, missionId, name);
      if (result.ok) return revealed(201, result);
      switch (result.reason) {
        case 'not-found':
          return json(404, NOT_FOUND);
        case 'inactive':
          return inactive(result.state);
        case 'invalid-name':
          return json(400, { error: 'invalid-name', message: result.problem });
        case 'name-taken':
          return json(409, {
            error: 'name-taken',
            message:
              'A working token of this mission already has this name. Revoke it first, or choose another name.',
          });
      }
    },

    async revokeToken(request, missionId, tokenId) {
      const principal = await userOf(request);
      if (principal instanceof Response) return principal;
      const result = await deps.team.revokeToken(principal.user, missionId, tokenId);
      if (!result.ok) return json(404, NOT_FOUND);
      return json(200, { token_id: result.token_id, already: result.already });
    },
  };
}
