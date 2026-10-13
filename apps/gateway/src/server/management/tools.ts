/**
 * `ManagementTools` — the seven acts of the management door (spec §4.1 bis),
 * each one a thin, typed projection of the mission service with the
 * **delegating user as the actor**:
 *
 *   read      `listMyConnections`, `getCatalog`, `listMyMissions`
 *   preview   `previewPolicy` — writes nothing
 *   mutate    `issueMission`, `rotateMissionToken`, `revokeMission`
 *
 * Authority is never decided here. `previewDraft` (missions) says what a
 * draft may accept from the user's *current* authority — owner, or the union
 * of their shares — and `issue` re-checks it; this class only passes the
 * user's id and the delegation along and words the answers. A mission issued
 * here has the user as creator, records the delegation (`issued_via`) and
 * leaves a `mission-issued` entry naming the client; `rotate` and `revoke`
 * leave theirs the same way.
 *
 * There is no method for anything else, and the ports this class is built
 * from could not do anything else (`ports.ts`).
 */
import { MISSION_TOKEN_ENV, maskedToken, type BootstrapKit, type MissionDraft } from '../missions';
import type { Logger } from '../logging';
import type {
  ManagementActor,
  ManagementCatalog,
  ManagementMissions,
  ManagementRateLimit,
} from './ports';
import {
  catalogView,
  connectionView,
  missionDetailView,
  missionView,
  previewView,
  type CatalogView,
  type ConnectionView,
  type MissionDetailView,
  type MissionStateName,
  type MissionView,
  type OrphanView,
  type PreviewView,
} from './views';

/** Mutations (issue, rotate, revoke) one delegation may perform per window. */
export const MANAGEMENT_MUTATIONS_PER_WINDOW = 60;
export const MANAGEMENT_MUTATION_WINDOW_MS = 3_600_000;
const MS_PER_SECOND = 1000;

/**
 * Every code a tool refuses with. `tools.test.ts` holds this list to the table
 * of the handbook, so a code added here is documented or the build fails.
 */
export const MANAGEMENT_REFUSAL_CODES = [
  'draft-refused',
  'mission-not-found',
  'mission-inactive',
  'mission-not-issued-here',
  'unknown-provider',
  'unknown-connection',
  'rate-limited',
] as const;
export type ManagementRefusalCode = (typeof MANAGEMENT_REFUSAL_CODES)[number];

/** A tool's "no", in the shape of the execution door's refusals: a code, a sentence, what to do. */
export interface ManagementRefusal {
  readonly code: ManagementRefusalCode;
  readonly message: string;
  readonly hint: string;
  readonly [field: string]: unknown;
}

export type ToolOutcome<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly refusal: ManagementRefusal };

const done = <T>(data: T): ToolOutcome<T> => ({ ok: true, data });
const refused = (refusal: ManagementRefusal): ToolOutcome<never> => ({ ok: false, refusal });

export interface ConnectionsAnswer {
  readonly connections: readonly ConnectionView[];
  /** Connections of experimental providers left out; pass `include_experimental` to see them. */
  readonly hidden_experimental: number;
}

export interface MissionsAnswer {
  readonly missions: readonly (MissionView | MissionDetailView)[];
  /** Revoked and expired missions left out; pass `include_closed` to see them. */
  readonly hidden_closed: number;
}

/** A mission token, the only time it exists outside the gateway. */
export interface RevealedTokenView {
  readonly secret: string;
  readonly prefix: string;
  /** The variable the bootstrap kit's snippets refer to. */
  readonly env_var: string;
  readonly shown_once: true;
}

export type BootstrapKitView = Pick<
  BootstrapKit,
  'endpoint' | 'env' | 'mcp_json' | 'agent_instructions' | 'verify'
>;

export interface IssuedMissionAnswer {
  readonly mission: {
    readonly mission_id: string;
    readonly name: string;
    /** The delegating user: the mission is theirs, and only they answer its requests. */
    readonly creator_user_id: string;
    /** This client, recorded on the mission and in the audit. */
    readonly issued_via_client_id: string;
    readonly expires_at: string | null;
  };
  readonly token: RevealedTokenView;
  /** What the executing agent needs: environment variable, MCP configuration, instructions, check. */
  readonly bootstrap_kit: BootstrapKitView;
  readonly policy: PreviewView['policy'];
  readonly summary: PreviewView['summary'];
  readonly notices: PreviewView['notices'];
}

export interface RotatedTokenAnswer {
  readonly mission_id: string;
  readonly token: RevealedTokenView;
  readonly bootstrap_kit: BootstrapKitView;
}

export interface RevokedMissionAnswer {
  readonly mission_id: string;
  readonly state: 'revoked';
  readonly tokens_revoked: number;
  /** True when the mission was revoked before this call: nothing changed. */
  readonly already_revoked: boolean;
}

export interface ManagementToolsDeps {
  readonly missions: ManagementMissions;
  readonly catalog: ManagementCatalog;
  readonly rateLimit: ManagementRateLimit;
  readonly logger: Logger;
}

function kitView(kit: BootstrapKit): BootstrapKitView {
  return {
    endpoint: kit.endpoint,
    env: kit.env,
    mcp_json: kit.mcp_json,
    agent_instructions: kit.agent_instructions,
    verify: kit.verify,
  };
}

function tokenView(token: { secret: string; prefix: string }): RevealedTokenView {
  return {
    secret: token.secret,
    prefix: token.prefix,
    env_var: MISSION_TOKEN_ENV,
    shown_once: true,
  };
}

/** The refusal of a draft: its preview, whose uncovered list is the one it shows. */
function draftRefusal(preview: PreviewView): ManagementRefusal {
  const { uncovered } = preview;
  const beyond = uncovered.length > 0;
  return {
    code: 'draft-refused',
    message: beyond
      ? 'The draft accepts risks outside the user’s authority. Nothing was issued.'
      : 'The draft cannot be issued as written. Nothing was issued.',
    hint: beyond
      ? 'Remove the ids listed in `uncovered` (or ask the user to obtain a wider share from the connection’s owner in the interface), fix the other `issues` if any, then call `preview_policy` until it answers `ok: true`.'
      : 'Fix every entry of `issues`, then call `preview_policy` until it answers `ok: true`.',
    uncovered,
    issues: preview.issues,
    preview,
  };
}

const NOT_FOUND_HINT =
  'Call `list_my_missions` for the ids of the user’s missions. A mission of another user reads the same as one that does not exist.';

function missionNotFound(missionId: string): ManagementRefusal {
  return {
    code: 'mission-not-found',
    message: `No mission "${missionId}" among the user’s missions.`,
    hint: NOT_FOUND_HINT,
    mission_id: missionId,
  };
}

function notIssuedHere(missionId: string): ManagementRefusal {
  return {
    code: 'mission-not-issued-here',
    message: `Mission "${missionId}" was not issued through this delegation; its token is not rotated here.`,
    hint: 'You rotate only the missions this delegation issued (`issued_via.this_delegation` in `list_my_missions`). The user rotates any of their missions in the web interface, on the mission’s page. You may still end this mission with `revoke_mission`, or issue a new one.',
    mission_id: missionId,
  };
}

export class ManagementTools {
  constructor(private readonly deps: ManagementToolsDeps) {}

  // ───────────────────────────────────────────────────────────────────────────
  // Read
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * The connections the user may build a mission from — the ones they own and
   * the ones shared with them, directly or through a group — each with its
   * exact restriction, its resources and its presets.
   */
  async listMyConnections(
    actor: ManagementActor,
    input: { readonly include_experimental?: boolean } = {},
  ): Promise<ToolOutcome<ConnectionsAnswer>> {
    const context = await this.deps.missions.issuanceContext({ id: actor.userId });
    const shown = context.filter((c) => input.include_experimental === true || !c.experimental);
    return done({
      connections: shown.map(connectionView),
      hidden_experimental: context.length - shown.length,
    });
  }

  /**
   * One provider's risk catalog as explicit ids, with its presets. With a
   * connection of the user, each id says whether their authority covers it.
   */
  async getCatalog(
    actor: ManagementActor,
    input: { readonly provider: string; readonly connection_id?: string },
  ): Promise<ToolOutcome<CatalogView>> {
    const catalog = this.deps.catalog.get(input.provider);
    if (!catalog) {
      return refused({
        code: 'unknown-provider',
        message: `This instance has no provider "${input.provider}".`,
        hint: 'Use a provider id of `list_my_connections`, or one of `providers`.',
        providers: this.deps.catalog.providers(),
      });
    }
    if (input.connection_id === undefined) return done(catalogView(catalog, null));
    const context = await this.deps.missions.issuanceContext({ id: actor.userId });
    const connection = context.find(
      (c) => c.id === input.connection_id && c.provider === catalog.provider,
    );
    if (!connection) {
      return refused({
        code: 'unknown-connection',
        message: `The user holds no ${catalog.provider} connection "${input.connection_id}".`,
        hint: 'Use a `connection_id` of `list_my_connections`, or leave it out to read the catalog alone.',
        connection_id: input.connection_id,
      });
    }
    return done(catalogView(catalog, connection));
  }

  /**
   * The user's missions, newest first: policy, state, session period and what
   * is left of each budget. With `mission_id`, that mission with its
   * connections and resources.
   */
  async listMyMissions(
    actor: ManagementActor,
    input: { readonly mission_id?: string; readonly include_closed?: boolean } = {},
  ): Promise<ToolOutcome<MissionsAnswer>> {
    const user = { id: actor.userId };
    if (input.mission_id !== undefined) {
      const detail = await this.deps.missions.get(user, input.mission_id);
      if (!detail) return refused(missionNotFound(input.mission_id));
      return done({
        missions: [missionDetailView(detail, actor, maskedToken)],
        hidden_closed: 0,
      });
    }
    const all = (await this.deps.missions.list(user)).map((overview) =>
      missionView(overview, actor, maskedToken),
    );
    const shown = all.filter(
      (m) => input.include_closed === true || (m.state !== 'revoked' && m.state !== 'expired'),
    );
    return done({ missions: shown, hidden_closed: all.length - shown.length });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Preview
  // ───────────────────────────────────────────────────────────────────────────

  /** What passes, what exceeds the user's authority, what the mission could call. Writes nothing. */
  async previewPolicy(
    actor: ManagementActor,
    draft: MissionDraft,
  ): Promise<ToolOutcome<PreviewView>> {
    return done(previewView(await this.deps.missions.preview({ id: actor.userId }, draft)));
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Mutations — each leaves an administrative entry naming the user and the client
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Issues the mission in the user's name. A draft that exceeds their
   * authority, or cannot be issued for any other reason, is refused whole
   * with the uncovered list; nothing is narrowed silently.
   */
  async issueMission(
    actor: ManagementActor,
    draft: MissionDraft,
  ): Promise<ToolOutcome<IssuedMissionAnswer>> {
    const user = { id: actor.userId };
    // A draft that cannot be issued is answered before the mutation budget is
    // touched: an agent fixing its draft is not an agent issuing missions.
    const checked = await this.deps.missions.preview(user, draft);
    if (!checked.ok) {
      this.log('issue_mission', actor, 'draft-refused');
      return refused(draftRefusal(previewView(checked)));
    }
    const limited = await this.takeMutation(actor);
    if (limited) return refused(limited);
    const result = await this.deps.missions.issue(user, draft, {
      delegation: { id: actor.delegationId, clientId: actor.clientId },
    });
    if (!result.ok) {
      // The authority changed between the two reads: `issue` decides.
      if (result.reason !== 'refused') {
        throw new Error(`management door: unexpected issuance outcome "${result.reason}"`);
      }
      this.log('issue_mission', actor, 'draft-refused');
      return refused(draftRefusal(previewView(result.preview)));
    }
    this.log('issue_mission', actor, 'issued', result.mission.id);
    const preview = previewView(result.preview);
    return done({
      mission: {
        mission_id: result.mission.id,
        name: result.mission.name,
        creator_user_id: result.mission.creatorUserId,
        issued_via_client_id: actor.clientId,
        expires_at: result.mission.expiresAt,
      },
      token: tokenView(result.token),
      bootstrap_kit: kitView(result.kit),
      policy: preview.policy,
      summary: preview.summary,
      notices: preview.notices,
    });
  }

  /**
   * A new token for a mission this delegation issued; the previous one stops
   * working. A mission of the user that the delegation did not issue — the
   * human's own, another client's, an earlier delegation's — is refused: the
   * answer carries the new token, and a delegated client must not come to hold
   * the token of a mission nobody issued to it. Only a mission that serves
   * calls is rotated: a revoked, expired or orphaned one is refused — orphaned
   * as the user's authority stands now (the mission service derives it at
   * every read).
   */
  async rotateMissionToken(
    actor: ManagementActor,
    input: { readonly mission_id: string },
  ): Promise<ToolOutcome<RotatedTokenAnswer>> {
    const user = { id: actor.userId };
    const detail = await this.deps.missions.get(user, input.mission_id);
    if (!detail) return refused(missionNotFound(input.mission_id));
    if (detail.mission.delegationId !== actor.delegationId) {
      this.log('rotate_mission_token', actor, 'mission-not-issued-here', detail.mission.id);
      return refused(notIssuedHere(detail.mission.id));
    }
    if (detail.state.kind !== 'active') {
      this.log('rotate_mission_token', actor, 'mission-inactive', detail.mission.id);
      return refused(
        inactive(
          detail.mission.id,
          detail.state.kind,
          missionView(detail, actor, maskedToken).orphan,
        ),
      );
    }
    const limited = await this.takeMutation(actor);
    if (limited) return refused(limited);
    const result = await this.deps.missions.rotate(user, input.mission_id, {
      delegation: { id: actor.delegationId, clientId: actor.clientId },
    });
    if (!result.ok) {
      if (result.reason === 'not-found') return refused(missionNotFound(input.mission_id));
      if (result.reason === 'not-issued-by-delegation') {
        return refused(notIssuedHere(input.mission_id));
      }
      return refused(inactive(input.mission_id, result.state, null));
    }
    this.log('rotate_mission_token', actor, 'rotated', result.mission.id);
    return done({
      mission_id: result.mission.id,
      token: tokenView(result.token),
      bootstrap_kit: kitView(result.kit),
    });
  }

  /**
   * Ends one of the user's missions: every call is refused from now on.
   * Terminal; idempotent. An orphaned mission is revoked like any other: this
   * is how it is closed for good.
   */
  async revokeMission(
    actor: ManagementActor,
    input: { readonly mission_id: string },
  ): Promise<ToolOutcome<RevokedMissionAnswer>> {
    const user = { id: actor.userId };
    const detail = await this.deps.missions.get(user, input.mission_id);
    if (!detail) return refused(missionNotFound(input.mission_id));
    if (detail.state.kind === 'revoked') {
      return done({
        mission_id: detail.mission.id,
        state: 'revoked',
        tokens_revoked: 0,
        already_revoked: true,
      });
    }
    const limited = await this.takeMutation(actor);
    if (limited) return refused(limited);
    const result = await this.deps.missions.revoke(user, input.mission_id, {
      delegation: { id: actor.delegationId, clientId: actor.clientId },
    });
    if (!result.ok) return refused(missionNotFound(input.mission_id));
    this.log('revoke_mission', actor, 'revoked', result.mission.id);
    return done({
      mission_id: result.mission.id,
      state: 'revoked',
      tokens_revoked: result.tokensRevoked,
      already_revoked: false,
    });
  }

  /** The per-delegation budget of mutations; `null` when the act may proceed. */
  private async takeMutation(actor: ManagementActor): Promise<ManagementRefusal | null> {
    const decision = await this.deps.rateLimit.take(
      `delegation:${actor.delegationId}:mutations`,
      MANAGEMENT_MUTATIONS_PER_WINDOW,
      MANAGEMENT_MUTATION_WINDOW_MS,
    );
    if (decision.allowed) return null;
    const seconds = Math.max(1, Math.ceil(decision.retryAfterMs / MS_PER_SECOND));
    this.deps.logger.warn('management mutations rate-limited', {
      delegation_id: actor.delegationId,
      client_id: actor.clientId,
      retry_after_seconds: seconds,
    });
    return {
      code: 'rate-limited',
      message: `This delegation issued, rotated or revoked too many missions; retry in ${seconds} s.`,
      hint: 'Wait `retry_after_seconds`. Nothing was changed by this call.',
      retry_after_seconds: seconds,
    };
  }

  private log(tool: string, actor: ManagementActor, outcome: string, missionId?: string): void {
    this.deps.logger.info('management act', {
      tool,
      outcome,
      user_id: actor.userId,
      delegation_id: actor.delegationId,
      client_id: actor.clientId,
      ...(missionId ? { mission_id: missionId } : {}),
    });
  }
}

function inactive(
  missionId: string,
  state: MissionStateName,
  orphan: OrphanView | null,
): ManagementRefusal {
  const why: Readonly<Record<MissionStateName, string>> = {
    active: 'is active',
    revoked: 'was revoked',
    expired: 'has expired',
    orphaned: 'is orphaned: the authority it was issued under is gone',
  };
  return {
    code: 'mission-inactive',
    message: `Mission "${missionId}" ${why[state]}; its token is not rotated.`,
    hint:
      state === 'orphaned'
        ? 'The mission serves calls again, with the same token, when the authority returns (the connection’s owner shares it again, in the interface): you cannot restore it here. To close it for good use `revoke_mission`; to work now, issue a new mission within what `list_my_connections` shows.'
        : 'Issue a new mission with `issue_mission`.',
    mission_id: missionId,
    state,
    ...(orphan ? { orphan } : {}),
  };
}
