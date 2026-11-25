/**
 * `VaubaanActs` — the nine acts of the `vaubaan` plugin (spec §4.1 bis), each a
 * thin, typed projection of the mission service with the **calling mission's
 * creator as the actor**:
 *
 *   read      `listMyAccounts`, `getCatalog`, `listMyMissions`
 *   preview   `previewPolicy` — of an issuance, or of an edit; writes nothing
 *   mutate    `issueMission`, `renameMission`, `editMission`,
 *             `rotateMissionToken`, `revokeMission`
 *
 * Authority is never decided here. `previewDraft` (missions) says what a draft
 * may accept from the user's *current* authority — owner, or the union of their
 * shares — and `issue` re-checks it; this class passes the user's id and the
 * calling mission along and words the answers. A mission issued here has the
 * user as creator, records the issuing mission (`issued_via`) and leaves a
 * `mission-issued` entry naming it; `rotate` and `revoke` leave theirs the same
 * way. A rename or an edit is the creator's "Edit mission" (`MissionService.edit`):
 * one version in the History, authored by the calling mission, one
 * `mission-changed` entry naming it.
 *
 * **The self rule** (ADR platform-management-is-a-plugin-on-the-execution-door)
 * is checked here, at every call, whatever the stored selection says — like
 * `isSelfResource` for the instance's own hosting:
 *
 *   - a draft carrying a `vaubaan` account is refused (`vaubaan-account-not-allowed`),
 *     at issuance and at an edit: a mission issued or edited here never prepares
 *     missions itself;
 *   - the calling mission never renames, edits, rotates or revokes itself
 *     (`self-not-allowed`);
 *   - `rotate_mission_token` reaches only the missions the calling mission issued.
 *
 * There is no method for anything else, and the ports this class is built from
 * could not do anything else (`ports.ts`). The calling mission's own budget is
 * the limit on how many acts it performs: there is no rate limit of its own.
 */
import type { VaubaanCaller } from '@vaubaan/plugin-vaubaan';

import type { Logger } from '../logging';
import {
  MISSION_TOKEN_ENV,
  maskedToken,
  hasChanges,
  type BootstrapKit,
  type EditResult,
  type IssuanceAccount,
  type LimitReachedResult,
  type MissionChanges,
  type MissionDraft,
  type MissionEditView,
  type PreviewIssue,
  type PreviewNotice,
} from '../missions';
import type { VaubaanCatalog, VaubaanMissions } from './ports';
import {
  catalogView,
  accountView,
  missionDetailView,
  missionView,
  previewView,
  type CatalogView,
  type AccountView,
  type MissionDetailView,
  type MissionStateName,
  type MissionView,
  type OrphanView,
  type PreviewView,
  type UncoveredView,
} from './views';

/** The service id of the gateway's own account: a mission issued here never carries one. */
export const VAUBAAN_SERVICE = 'vaubaan';

/**
 * Every code an act refuses with. `acts.test.ts` holds this list to the table
 * of the handbook, so a code added here is documented or the build fails.
 */
export const VAUBAAN_REFUSAL_CODES = [
  'invalid-arguments',
  'draft-refused',
  'vaubaan-account-not-allowed',
  'outlives-calling-mission',
  'self-not-allowed',
  'teammate-key-not-allowed',
  'mission-not-found',
  'mission-inactive',
  'mission-not-issued-here',
  'mission-changed-meanwhile',
  'unknown-service',
  'unknown-account',
  'instance-limit-reached',
  'administrator-only',
  'plugin-refused',
] as const;
export type VaubaanRefusalCode = (typeof VAUBAAN_REFUSAL_CODES)[number];

/** An act's "no", in the shape of the execution door's refusals: a code, a sentence, what to do. */
export interface ActRefusal {
  readonly code: VaubaanRefusalCode;
  readonly message: string;
  readonly hint: string;
  readonly [field: string]: unknown;
}

export type ActOutcome<T> =
  { readonly ok: true; readonly data: T } | { readonly ok: false; readonly refusal: ActRefusal };

const done = <T>(data: T): ActOutcome<T> => ({ ok: true, data });
const refused = (refusal: ActRefusal): ActOutcome<never> => ({ ok: false, refusal });

export interface AccountsAnswer {
  readonly accounts: readonly AccountView[];
}

/**
 * One mission read by its id: for its creator, also the mission as a draft — the
 * starting point of `edit_mission` — or `null` for a mission they are only a member of.
 */
export type MissionReadView = MissionDetailView & { readonly draft: MissionDraft | null };

export interface MissionsAnswer {
  readonly missions: readonly (MissionView | MissionReadView)[];
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
  'endpoint' | 'env' | 'mcp_json' | 'agent_instructions' | 'git' | 'verify'
>;

export interface IssuedMissionAnswer {
  readonly mission: {
    readonly mission_id: string;
    readonly name: string;
    /** The calling mission's creator: the mission is theirs, and only they answer its requests. */
    readonly creator_user_id: string;
    /** The calling mission, recorded on the new one and in the audit. */
    readonly issued_by_mission_id: string;
    readonly expires_at: string | null;
  };
  readonly token: RevealedTokenView;
  /** What the executing agent needs: environment variable, MCP configuration, instructions, check. */
  readonly bootstrap_kit: BootstrapKitView;
  readonly policy: PreviewView['policy'];
  readonly summary: PreviewView['summary'];
  readonly notices: PreviewView['notices'];
}

/** What an edit of a mission would do (`preview_policy` with `mission_id`); writes nothing. */
export interface EditPreviewAnswer {
  readonly mission_id: string;
  /** True when `edit_mission` would accept this draft unchanged. */
  readonly ok: boolean;
  /** Why the edit cannot be applied as written; only about what it moves. */
  readonly issues: readonly PreviewIssue[];
  readonly notices: readonly PreviewNotice[];
  /** Accepted risks outside the user's authority, per account. */
  readonly uncovered: readonly UncoveredView[];
  /** What the edit moves; all empty for a draft equal to the mission. */
  readonly changes: MissionChanges;
}

export interface EditedMissionAnswer {
  readonly mission_id: string;
  readonly name: string;
  /** False when the draft was the mission as it stands: nothing was written. */
  readonly changed: boolean;
  readonly changes: MissionChanges;
  /** The open requests of the mission the edit made moot, now closed. */
  readonly requests_closed: readonly string[];
}

export interface RenamedMissionAnswer {
  readonly mission_id: string;
  readonly name: string;
  /** False when the mission already had this name: nothing was written. */
  readonly renamed: boolean;
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

export interface VaubaanActsDeps {
  readonly missions: VaubaanMissions;
  readonly catalog: VaubaanCatalog;
  readonly logger: Logger;
}

function kitView(kit: BootstrapKit): BootstrapKitView {
  return {
    endpoint: kit.endpoint,
    env: kit.env,
    mcp_json: kit.mcp_json,
    agent_instructions: kit.agent_instructions,
    git: kit.git,
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

/**
 * The instance's ceiling of active missions refuses the issuance, or a new end
 * that would revive an ended mission (spec §4.3 bis).
 */
function instanceLimitRefusal(
  message: string,
  limit: LimitReachedResult['limit'],
  outcome: 'issued' | 'changed' = 'issued',
): ActRefusal {
  return {
    code: 'instance-limit-reached',
    message: `${message} Nothing was ${outcome}.`,
    hint: 'The draft is fine: the gateway holds as many active missions as its operator allows. Ask the user to revoke a mission they no longer need, or the operator of the gateway to raise the ceiling, then issue again.',
    count: limit.count,
    ceiling: limit.limit,
  };
}

/** The refusal of a draft: its preview, whose uncovered list is the one it shows. */
function draftRefusal(preview: PreviewView): ActRefusal {
  const { uncovered } = preview;
  const beyond = uncovered.length > 0;
  return {
    code: 'draft-refused',
    message: beyond
      ? 'The draft accepts risks outside the user’s authority. Nothing was issued.'
      : 'The draft cannot be issued as written. Nothing was issued.',
    hint: beyond
      ? 'Remove the ids listed in `uncovered` (or ask the user to obtain a wider share from the account’s owner in the interface), fix the other `issues` if any, then call `vaubaan__preview_policy` until it answers `ok: true`.'
      : 'Fix every entry of `issues`, then call `vaubaan__preview_policy` until it answers `ok: true`.',
    uncovered,
    issues: preview.issues,
    preview,
  };
}

/** A draft naming a Vaubaan account: refused whole, whatever else it says. */
function vaubaanAccountRefusal(
  accountIds: readonly string[],
  outcome: 'issued' | 'changed' = 'issued',
): ActRefusal {
  return {
    code: 'vaubaan-account-not-allowed',
    message: `A mission issued or edited by a mission never carries a Vaubaan account. Nothing was ${outcome}.`,
    hint: 'Remove the Vaubaan account from the draft: the mission you prepare works on the services, not on missions. Only the user gives a mission a Vaubaan account, in the web interface.',
    account_ids: accountIds,
  };
}

/**
 * A mission issued through a mission never outlives it: a stolen key cannot mint missions
 * that keep working once its own end is reached.
 */
function outlivesCallerRefusal(callerId: string, callerEnd: string): ActRefusal {
  return {
    code: 'outlives-calling-mission',
    message: `A mission issued by mission "${callerId}" ends at ${callerEnd} at the latest, when it does. Nothing was issued.`,
    hint: `Set \`expires_at\` to ${callerEnd} or earlier. A mission that must last longer is issued by the user, in the web interface.`,
    mission_id: callerId,
    expires_at: callerEnd,
  };
}

/** Whether `end` (`null`: never) is after `limit`. */
function endsAfter(end: string | null, limit: string): boolean {
  return end === null || Date.parse(end) > Date.parse(limit);
}

/** What an act does to a mission, as its refusals word it. */
type MissionVerb = 'renamed' | 'edited' | 'rotated' | 'revoked';

/** The calling mission named itself. */
function selfRefusal(missionId: string, act: MissionVerb): ActRefusal {
  return {
    code: 'self-not-allowed',
    message: `Mission "${missionId}" is the mission making this call: it is never ${act} through its own key.`,
    hint: 'The user renames, edits, rotates or revokes this mission in the web interface, on the mission’s page.',
    mission_id: missionId,
  };
}

/** The mission moved between the read of its revision and the write: nothing was written. */
function changedMeanwhile(missionId: string): ActRefusal {
  return {
    code: 'mission-changed-meanwhile',
    message: `Mission "${missionId}" changed while this call ran. Nothing was changed.`,
    hint: 'Read it again with `vaubaan__list_my_missions` and `mission_id` (its `draft`), apply your change to it, and call again.',
    mission_id: missionId,
  };
}

/** The accepted risks outside the authority, from an edit's issues (`exceeds-authority`). */
function uncoveredOfIssues(
  issues: readonly PreviewIssue[],
  context: readonly IssuanceAccount[],
): UncoveredView[] {
  return issues
    .filter((issue) => issue.code === 'exceeds-authority' && issue.account_id !== undefined)
    .map((issue) => ({
      account_id: issue.account_id ?? '',
      service: context.find((c) => c.id === issue.account_id)?.service ?? '',
      risk_ids: issue.risk_ids ?? [],
    }));
}

/** The refusal of an edit the mission service judged: its issues, what it would move. */
function editRefusal(
  missionId: string,
  issues: readonly PreviewIssue[],
  changes: MissionChanges,
  uncovered: readonly UncoveredView[],
): ActRefusal {
  const beyond = uncovered.length > 0;
  return {
    code: 'draft-refused',
    message: beyond
      ? 'The edit accepts risks outside the user’s authority. Nothing was changed.'
      : 'The edit cannot be applied as written. Nothing was changed.',
    hint: beyond
      ? 'Remove the ids listed in `uncovered` (or ask the user to obtain a wider share from the account’s owner in the interface), fix the other `issues` if any, then call `vaubaan__preview_policy` with `mission_id` until it answers `ok: true`.'
      : 'Fix every entry of `issues`, then call `vaubaan__preview_policy` with `mission_id` until it answers `ok: true`.',
    mission_id: missionId,
    uncovered,
    issues,
    changes,
  };
}

/** What the mission service could not read as an edit (the schema read it first: rare). */
function invalidEdit(problems: readonly string[]): ActRefusal {
  return {
    code: 'invalid-arguments',
    message: 'The draft is not an edit of the mission. Nothing was changed.',
    hint: 'Fix every entry of `issues`, as the tool’s input schema in `tools/list` describes it.',
    issues: problems.map((message) => ({ path: '', message })),
  };
}

const NOT_FOUND_HINT =
  'Call `vaubaan__list_my_missions` for the ids of the user’s missions. A mission of another user reads the same as one that does not exist, and so does, for a tool that changes a mission, one the user is only a member of (`role: member`): its creator alone changes it.';

function missionNotFound(missionId: string): ActRefusal {
  return {
    code: 'mission-not-found',
    message: `No mission "${missionId}" among the user’s missions.`,
    hint: NOT_FOUND_HINT,
    mission_id: missionId,
  };
}

function notIssuedHere(missionId: string): ActRefusal {
  return {
    code: 'mission-not-issued-here',
    message: `Mission "${missionId}" was not issued by the mission making this call; its token is not rotated here.`,
    hint: 'You rotate only the missions this mission issued (`issued_via.this_mission` in `vaubaan__list_my_missions`). The user rotates any of their missions in the web interface, on the mission’s page. You may still end this mission with `vaubaan__revoke_mission`, or issue a new one.',
    mission_id: missionId,
  };
}

/** The Vaubaan accounts a draft names, by id or by service. */
function vaubaanAccountsOf(
  draft: MissionDraft,
  context: readonly IssuanceAccount[],
): readonly string[] {
  const vaubaan = new Set(context.filter((c) => c.service === VAUBAAN_SERVICE).map((c) => c.id));
  const named: string[] = [];
  for (const account of draft.accounts) {
    if (account.service === VAUBAAN_SERVICE) named.push(account.account_id ?? VAUBAAN_SERVICE);
    else if (account.account_id !== undefined && vaubaan.has(account.account_id)) {
      named.push(account.account_id);
    }
  }
  return named;
}

export class VaubaanActs {
  constructor(private readonly deps: VaubaanActsDeps) {}

  // ───────────────────────────────────────────────────────────────────────────
  // Read
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * The accounts the user may build a mission from — the ones they own and
   * the ones shared with them, directly or through a group — each with its
   * exact restriction, its resources and its macro-actions.
   */
  async listMyAccounts(caller: VaubaanCaller): Promise<ActOutcome<AccountsAnswer>> {
    const context = await this.deps.missions.issuanceContext({ id: caller.userId });
    return done({ accounts: context.map(accountView) });
  }

  /**
   * One service's risk catalog as explicit ids, with its macro-actions. With an
   * account of the user, each id says whether their authority covers it.
   */
  async getCatalog(
    caller: VaubaanCaller,
    input: { readonly service: string; readonly account_id?: string | undefined },
  ): Promise<ActOutcome<CatalogView>> {
    const catalog = this.deps.catalog.get(input.service);
    if (!catalog) {
      return refused({
        code: 'unknown-service',
        message: `This instance has no service "${input.service}".`,
        hint: 'Use a service id of `vaubaan__list_my_accounts`, or one of `services`.',
        services: this.deps.catalog.services(),
      });
    }
    if (input.account_id === undefined) return done(catalogView(catalog, null));
    const context = await this.deps.missions.issuanceContext({ id: caller.userId });
    const account = context.find((c) => c.id === input.account_id && c.service === catalog.service);
    if (!account) {
      return refused({
        code: 'unknown-account',
        message: `The user holds no ${catalog.service} account "${input.account_id}".`,
        hint: 'Use a `account_id` of `vaubaan__list_my_accounts`, or leave it out to read the catalog alone.',
        account_id: input.account_id,
      });
    }
    return done(catalogView(catalog, account));
  }

  /**
   * The user's missions, newest first: policy, state, current period and what
   * is left of each budget. With `mission_id`, that mission with its
   * accounts and resources. The missions the user created and the ones
   * shared with them as a member, each marked with its `role`.
   */
  async listMyMissions(
    caller: VaubaanCaller,
    input: {
      readonly mission_id?: string | undefined;
      readonly include_closed?: boolean | undefined;
    } = {},
  ): Promise<ActOutcome<MissionsAnswer>> {
    const user = { id: caller.userId };
    const viewer = { missionId: caller.missionId };
    if (input.mission_id !== undefined) {
      const detail = await this.deps.missions.get(user, input.mission_id);
      if (!detail) return refused(missionNotFound(input.mission_id));
      // The draft an edit starts from: the creator's alone, like the edit itself.
      const edit =
        detail.role === 'creator'
          ? await this.deps.missions.editView(user, detail.mission.id)
          : null;
      return done({
        missions: [
          { ...missionDetailView(detail, viewer, maskedToken), draft: edit?.draft ?? null },
        ],
        hidden_closed: 0,
      });
    }
    const all = (await this.deps.missions.list(user)).map((overview) =>
      missionView(overview, viewer, maskedToken),
    );
    const shown = all.filter(
      (m) => input.include_closed === true || (m.state !== 'revoked' && m.state !== 'expired'),
    );
    return done({ missions: shown, hidden_closed: all.length - shown.length });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Preview
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * What passes, what exceeds the user's authority, what the mission could call.
   * With `mission_id`, the preview of an edit of that mission instead — the
   * creator's own (`previewEdit`), so it judges exactly as `editMission` will.
   * Writes nothing.
   */
  async previewPolicy(
    caller: VaubaanCaller,
    input: MissionDraft & { readonly mission_id?: string | undefined },
  ): Promise<ActOutcome<PreviewView | EditPreviewAnswer>> {
    const { mission_id: missionId, ...draft } = input;
    const user = { id: caller.userId };
    if (missionId === undefined) {
      return done(previewView(await this.deps.missions.preview(user, draft)));
    }
    const target = await this.#editable(caller, missionId, 'edited');
    if (!target.ok) return target;
    const id = target.data.mission.id;
    const result = await this.deps.missions.previewEdit(user, id, {
      draft,
      revision: target.data.revision,
    });
    if (result.reason === 'not-found') return refused(missionNotFound(missionId));
    if (result.reason === 'inactive') return refused(inactive(id, result.state, null, 'edited'));
    if (result.reason === 'invalid-edit') return refused(invalidEdit(result.problems));
    const context = await this.deps.missions.issuanceContext(user);
    return done({
      mission_id: id,
      ok: result.ok,
      issues: result.issues,
      notices: result.notices,
      uncovered: uncoveredOfIssues(result.issues, context),
      changes: result.changes,
    });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Mutations — each leaves an administrative entry naming the user and the calling mission
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Issues the mission in the user's name. A draft that exceeds their
   * authority, or cannot be issued for any other reason, is refused whole
   * with the uncovered list; nothing is narrowed silently. A draft that names a
   * Vaubaan account is refused before anything else.
   */
  async issueMission(
    caller: VaubaanCaller,
    draft: MissionDraft,
  ): Promise<ActOutcome<IssuedMissionAnswer>> {
    const user = { id: caller.userId };
    const context = await this.deps.missions.issuanceContext(user);
    const vaubaan = vaubaanAccountsOf(draft, context);
    if (vaubaan.length > 0) {
      this.log('issue_mission', caller, 'vaubaan-account-not-allowed');
      return refused(vaubaanAccountRefusal(vaubaan));
    }
    const callerEnd = (await this.deps.missions.get(user, caller.missionId))?.mission.expiresAt;
    if (callerEnd && endsAfter(draft.expires_at, callerEnd)) {
      this.log('issue_mission', caller, 'outlives-calling-mission');
      return refused(outlivesCallerRefusal(caller.missionId, callerEnd));
    }
    const checked = await this.deps.missions.preview(user, draft);
    if (!checked.ok) {
      this.log('issue_mission', caller, 'draft-refused');
      return refused(draftRefusal(previewView(checked)));
    }
    const result = await this.deps.missions.issue(user, draft, {
      issuedBy: { missionId: caller.missionId },
    });
    if (!result.ok) {
      if (result.reason === 'limit-reached') {
        this.log('issue_mission', caller, 'instance-limit-reached');
        return refused(instanceLimitRefusal(result.message, result.limit));
      }
      // The authority changed between the two reads: `issue` decides.
      if (result.reason !== 'refused') {
        throw new Error(`vaubaan plugin: unexpected issuance outcome "${result.reason}"`);
      }
      this.log('issue_mission', caller, 'draft-refused');
      return refused(draftRefusal(previewView(result.preview)));
    }
    this.log('issue_mission', caller, 'issued', result.mission.id);
    const preview = previewView(result.preview);
    return done({
      mission: {
        mission_id: result.mission.id,
        name: result.mission.name,
        creator_user_id: result.mission.creatorUserId,
        issued_by_mission_id: caller.missionId,
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
   * Renames one of the user's missions: an edit of the name alone, through the
   * creator's own "Edit mission" — the mission's draft as it stands with the new
   * name — so it is one version in the History, authored by the calling mission,
   * and one `mission-changed` entry naming it. Never the calling mission itself.
   */
  async renameMission(
    caller: VaubaanCaller,
    input: { readonly mission_id: string; readonly name: string },
  ): Promise<ActOutcome<RenamedMissionAnswer>> {
    const target = await this.#editable(caller, input.mission_id, 'renamed');
    if (!target.ok) {
      this.log('rename_mission', caller, target.refusal.code, input.mission_id);
      return target;
    }
    const view = target.data;
    const result = await this.#applyEdit(caller, view, { ...view.draft, name: input.name });
    this.log(
      'rename_mission',
      caller,
      result.ok ? 'renamed' : result.refusal.code,
      view.mission.id,
    );
    if (!result.ok) return result;
    return done({
      mission_id: result.data.mission_id,
      name: result.data.name,
      renamed: result.data.changed,
    });
  }

  /**
   * Edits one of the user's missions as their "Edit mission" does: the draft is
   * the whole mission after the edit, judged under their authority now and
   * refused whole when it exceeds it (`uncovered`), never narrowed. A draft
   * naming a Vaubaan account is refused before anything else; the calling
   * mission is never edited. One version in the History, authored by the calling
   * mission; one `mission-changed` entry naming it.
   */
  async editMission(
    caller: VaubaanCaller,
    input: MissionDraft & { readonly mission_id: string },
  ): Promise<ActOutcome<EditedMissionAnswer>> {
    const { mission_id: missionId, ...draft } = input;
    const target = await this.#editable(caller, missionId, 'edited');
    if (!target.ok) {
      this.log('edit_mission', caller, target.refusal.code, missionId);
      return target;
    }
    const view = target.data;
    const context = await this.deps.missions.issuanceContext({ id: caller.userId });
    const vaubaan = vaubaanAccountsOf(draft, context);
    if (vaubaan.length > 0) {
      this.log('edit_mission', caller, 'vaubaan-account-not-allowed', view.mission.id);
      return refused(vaubaanAccountRefusal(vaubaan, 'changed'));
    }
    const result = await this.#applyEdit(caller, view, draft, context);
    this.log('edit_mission', caller, result.ok ? 'edited' : result.refusal.code, view.mission.id);
    return result;
  }

  /**
   * The mission the calling mission may rename or edit: one the user created,
   * not the calling mission, neither revoked nor orphaned (an expired one is:
   * a new end revives it, within the instance's ceiling).
   */
  async #editable(
    caller: VaubaanCaller,
    missionId: string,
    verb: 'renamed' | 'edited',
  ): Promise<ActOutcome<MissionEditView>> {
    // `null` for a mission of another user and for one the user is only a member of.
    const view = await this.deps.missions.editView({ id: caller.userId }, missionId);
    if (!view) return refused(missionNotFound(missionId));
    if (view.mission.id === caller.missionId) return refused(selfRefusal(view.mission.id, verb));
    if (view.blocked) return refused(inactive(view.mission.id, view.blocked, null, verb));
    return done(view);
  }

  /** `MissionService.edit` from the revision just read, in the calling mission's name. */
  async #applyEdit(
    caller: VaubaanCaller,
    view: MissionEditView,
    draft: MissionDraft,
    context?: readonly IssuanceAccount[],
  ): Promise<ActOutcome<EditedMissionAnswer>> {
    const user = { id: caller.userId };
    const id = view.mission.id;
    const result: EditResult = await this.deps.missions.edit(
      user,
      id,
      { draft, revision: view.revision },
      { issuedBy: { missionId: caller.missionId } },
    );
    if (result.ok) {
      return done({
        mission_id: result.mission.id,
        name: result.mission.name,
        changed: hasChanges(result.changes),
        changes: result.changes,
        requests_closed: result.requests_closed,
      });
    }
    switch (result.reason) {
      case 'not-found':
        return refused(missionNotFound(id));
      case 'inactive':
        return refused(inactive(id, result.state, null, 'edited'));
      case 'invalid-edit':
        return refused(invalidEdit(result.problems));
      case 'conflict':
        return refused(changedMeanwhile(id));
      case 'limit-reached':
        return refused(instanceLimitRefusal(result.message, result.limit, 'changed'));
      case 'refused': {
        const accounts = context ?? (await this.deps.missions.issuanceContext(user));
        const uncovered = uncoveredOfIssues(result.issues, accounts);
        return refused(editRefusal(id, result.issues, result.changes, uncovered));
      }
    }
  }

  /**
   * A new token for a mission the calling mission issued; the previous one
   * stops working. A mission of the user it did not issue — the human's own,
   * another mission's, an app's — is refused: the answer carries the new token,
   * and an agent must not come to hold the token of a mission nobody issued to
   * it. The calling mission itself is refused first. Only a mission that serves
   * calls is rotated: a revoked, expired or orphaned one is refused — orphaned
   * as the user's authority stands now (the mission service derives it at
   * every read).
   */
  async rotateMissionToken(
    caller: VaubaanCaller,
    input: { readonly mission_id: string },
  ): Promise<ActOutcome<RotatedTokenAnswer>> {
    const user = { id: caller.userId };
    const detail = await this.deps.missions.get(user, input.mission_id);
    // A mission the user is only a member of is read here, never changed.
    if (!detail || detail.role !== 'creator') return refused(missionNotFound(input.mission_id));
    if (detail.mission.id === caller.missionId) {
      this.log('rotate_mission_token', caller, 'self-not-allowed', detail.mission.id);
      return refused(selfRefusal(detail.mission.id, 'rotated'));
    }
    if (detail.mission.issuedByMissionId !== caller.missionId) {
      this.log('rotate_mission_token', caller, 'mission-not-issued-here', detail.mission.id);
      return refused(notIssuedHere(detail.mission.id));
    }
    if (detail.state.kind !== 'active') {
      this.log('rotate_mission_token', caller, 'mission-inactive', detail.mission.id);
      return refused(
        inactive(
          detail.mission.id,
          detail.state.kind,
          missionView(detail, { missionId: caller.missionId }, maskedToken).orphan,
          'rotated',
        ),
      );
    }
    const result = await this.deps.missions.rotate(user, detail.mission.id, {
      issuedBy: { missionId: caller.missionId },
    });
    if (!result.ok) {
      if (result.reason === 'not-found') return refused(missionNotFound(input.mission_id));
      if (result.reason === 'not-issued-by-mission')
        return refused(notIssuedHere(input.mission_id));
      return refused(inactive(input.mission_id, result.state, null, 'rotated'));
    }
    this.log('rotate_mission_token', caller, 'rotated', result.mission.id);
    return done({
      mission_id: result.mission.id,
      token: tokenView(result.token),
      bootstrap_kit: kitView(result.kit),
    });
  }

  /**
   * Ends one of the user's missions: every call is refused from now on.
   * Terminal; idempotent. An orphaned mission is revoked like any other: this
   * is how it is closed for good. Never the calling mission itself.
   */
  async revokeMission(
    caller: VaubaanCaller,
    input: { readonly mission_id: string },
  ): Promise<ActOutcome<RevokedMissionAnswer>> {
    const user = { id: caller.userId };
    const detail = await this.deps.missions.get(user, input.mission_id);
    // A mission the user is only a member of is read here, never changed.
    if (!detail || detail.role !== 'creator') return refused(missionNotFound(input.mission_id));
    if (detail.mission.id === caller.missionId) {
      this.log('revoke_mission', caller, 'self-not-allowed', detail.mission.id);
      return refused(selfRefusal(detail.mission.id, 'revoked'));
    }
    if (detail.state.kind === 'revoked') {
      return done({
        mission_id: detail.mission.id,
        state: 'revoked',
        tokens_revoked: 0,
        already_revoked: true,
      });
    }
    const result = await this.deps.missions.revoke(user, detail.mission.id, {
      issuedBy: { missionId: caller.missionId },
    });
    if (!result.ok) return refused(missionNotFound(input.mission_id));
    this.log('revoke_mission', caller, 'revoked', result.mission.id);
    return done({
      mission_id: result.mission.id,
      state: 'revoked',
      tokens_revoked: result.tokensRevoked,
      already_revoked: false,
    });
  }

  private log(tool: string, caller: VaubaanCaller, outcome: string, missionId?: string): void {
    this.deps.logger.info('vaubaan act', {
      tool,
      outcome,
      user_id: caller.userId,
      calling_mission_id: caller.missionId,
      ...(missionId ? { mission_id: missionId } : {}),
    });
  }
}

function inactive(
  missionId: string,
  state: MissionStateName,
  orphan: OrphanView | null,
  verb: 'renamed' | 'edited' | 'rotated',
): ActRefusal {
  const why: Readonly<Record<MissionStateName, string>> = {
    active: 'is active',
    revoked: 'was revoked',
    expired: 'has expired',
    orphaned: 'is orphaned: the authority it was issued under is gone',
  };
  return {
    code: 'mission-inactive',
    message: `Mission "${missionId}" ${why[state]}; ${verb === 'rotated' ? 'its token is not rotated' : `it is not ${verb}`}.`,
    hint:
      state === 'orphaned'
        ? 'The mission serves calls again, with the same token, when the authority returns (the account’s owner shares it again, in the interface): you cannot restore it here. To close it for good use `vaubaan__revoke_mission`; to work now, issue a new mission within what `vaubaan__list_my_accounts` shows.'
        : 'Issue a new mission with `vaubaan__issue_mission`.',
    mission_id: missionId,
    state,
    ...(orphan ? { orphan } : {}),
  };
}
