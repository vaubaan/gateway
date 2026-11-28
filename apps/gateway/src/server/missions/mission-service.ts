/**
 * `MissionService` — preview, issue, duplicate, rotate, revoke, and the gate
 * of a risk edited after issuance (spec §3.1, §3.2, §3.5, §7.4, §7.8; pivot
 * ADR D4).
 *
 * Reads accounts and resources through the store repositories only, asks
 * the `AuthorityService` what the creator may accept, and leaves the decision
 * to the pure `previewDraft`. A mission is persisted as an explicit
 * enumeration: explicit resource ids (even for "all"), explicit policy
 * entries (never a macro-action or trust level), and the creator's own token, whose
 * secret is returned once. Members and the other tokens of a mission are the
 * `MissionTeamService`'s (`team-service.ts`); this service says who may read a
 * mission (`access`) and what a presented token is worth (`verifyToken`).
 *
 * One rule for what a mission reaches on an account, shared with the
 * execution door (`execution/mission-context.ts`): exactly the resource ids
 * stored at issuance that discovery still returns. Scope `all` with an empty
 * list means "none known at issuance", never "everything discovered later";
 * the detail page and the bootstrap kit read it the same way.
 *
 * Store records are translated by `budget/mapping.ts` and
 * `accounts/mapping.ts` only; no record is written into an audit payload.
 *
 * The service is the one API of these acts; each is written in its use-case module
 * (`mission-issuance.ts`, `mission-tokens.ts`, `mission-closing.ts`,
 * `mission-policy-changes.ts`, `mission-reads.ts`, `mission-trust-raises.ts`,
 * `mission-edits.ts`), over the reads they share (`mission-lookups.ts`).
 */
import type { RiskId } from '@vaubaan/shared';

import type { Subject } from '../authority';
import type { MissionState } from '../budget';
import type { MissionRecord } from '../store/types';
import type { BootstrapKit } from './bootstrap-kit';
import type { IssuanceAccount, MissionDraft, MissionPreview } from '../../lib/missions/model';
import { type MissionHistoryView, type RestoreResult } from './history';
import type { TrustRaiseOffer } from './trust-raise';
import { MissionClosing } from './mission-closing';
import { MissionEdits } from './mission-edits';
import { MissionIssuance } from './mission-issuance';
import { MissionLookups } from './mission-lookups';
import { MissionPolicyChanges } from './mission-policy-changes';
import { MissionReads } from './mission-reads';
import { MissionTokens } from './mission-tokens';
import { MissionTrustRaises } from './mission-trust-raises';
export { gateEditBlockedBy } from './gate-edit';
export type {
  MissionServiceDeps,
  PreviewOptions,
  IssueOptions,
  RevealedToken,
  IssueResult,
  LimitReachedResult,
  RotateResult,
  RevokeResult,
  OrphanedOnAccount,
  MissionOnAccount,
  SetGateResult,
  LimitEdit,
  LimitChangeView,
  SetLimitsResult,
  MissionEditView,
  EditPreviewResult,
  EditResult,
  VerifiedToken,
  TokenRetirement,
  TokenVerification,
  MissionRole,
  MissionAccess,
  MissionLostAccount,
  MissionOrphanReason,
  MissionOverview,
  MissionDetailSet,
  MissionDetailAccount,
  MissionDetailRisk,
  MissionDetail,
  MissionIssuedAudit,
} from './mission-views';
import type {
  MissionServiceDeps,
  PreviewOptions,
  IssueOptions,
  IssueResult,
  RotateResult,
  RevokeResult,
  OrphanedOnAccount,
  MissionOnAccount,
  SetGateResult,
  LimitEdit,
  SetLimitsResult,
  MissionEditView,
  EditPreviewResult,
  EditResult,
  TokenVerification,
  MissionAccess,
  MissionOverview,
  MissionDetailAccount,
  MissionDetail,
} from './mission-views';

export class MissionService {
  // Private `#` fields, like `#edits`: a plain field would put the use cases into every
  // deep comparison of the root.
  /** The reads the use cases share (`mission-lookups.ts`). */
  readonly #lookups: MissionLookups;
  /** Edits, versions and restores (`mission-edits.ts`). */
  readonly #edits: MissionEdits;
  /** Preview, issue, draft again, duplicate (`mission-issuance.ts`). */
  readonly #issuance: MissionIssuance;
  /** The creator's rotation and a presented token's worth (`mission-tokens.ts`). */
  readonly #tokens: MissionTokens;
  /** Revoke, and the missions on an account (`mission-closing.ts`). */
  readonly #closing: MissionClosing;
  /** Gate, limits and permissions changed in place (`mission-policy-changes.ts`). */
  readonly #policy: MissionPolicyChanges;
  /** Trust-raise proposals (`mission-trust-raises.ts`). */
  readonly #trustRaises: MissionTrustRaises;
  /** The Missions pages' reads (`mission-reads.ts`). */
  readonly #reads: MissionReads;

  constructor(deps: MissionServiceDeps) {
    this.#lookups = new MissionLookups(deps);
    this.#edits = new MissionEdits(deps, this.#lookups);
    this.#issuance = new MissionIssuance(deps, this.#lookups);
    this.#tokens = new MissionTokens(deps, this.#lookups);
    this.#closing = new MissionClosing(deps, this.#lookups);
    this.#policy = new MissionPolicyChanges(deps, this.#lookups);
    this.#trustRaises = new MissionTrustRaises(deps, this.#lookups);
    this.#reads = new MissionReads(deps, this.#lookups, this.#trustRaises);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Edits and versions: mission-edits.ts
  // ───────────────────────────────────────────────────────────────────────────

  /** What the creator's edit form starts from; `null` when not the creator's. */
  editView(user: Subject, missionId: string): Promise<MissionEditView | null> {
    return this.#edits.editView(user, missionId);
  }

  /** What an edit would change, judged as an issuance would be, nothing written. */
  previewEdit(user: Subject, missionId: string, raw: unknown): Promise<EditPreviewResult> {
    return this.#edits.previewEdit(user, missionId, raw);
  }

  /** The creator's edit: a new version of the mission, or why it is refused. */
  edit(
    user: Subject,
    missionId: string,
    raw: unknown,
    options: IssueOptions = {},
  ): Promise<EditResult> {
    return this.#edits.edit(user, missionId, raw, options);
  }

  /** The mission's versions, newest first; `null` when the user cannot read the mission. */
  history(user: Subject, missionId: string): Promise<MissionHistoryView | null> {
    return this.#edits.history(user, missionId);
  }

  /** A former version made current again, as an edit. */
  restore(user: Subject, missionId: string, number: number): Promise<RestoreResult> {
    return this.#edits.restore(user, missionId, number);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Issuance context, preview, issue, duplicate: mission-issuance.ts
  // ───────────────────────────────────────────────────────────────────────────

  /** The accounts the user may build a mission from (`MissionLookups.issuanceContext`). */
  issuanceContext(user: Subject): Promise<IssuanceAccount[]> {
    return this.#lookups.issuanceContext(user);
  }

  /** What passes, what exceeds the authority, what becomes callable; writes nothing. */
  preview(
    user: Subject,
    draft: MissionDraft,
    options: PreviewOptions = {},
  ): Promise<MissionPreview> {
    return this.#issuance.preview(user, draft, options);
  }

  /** A new mission with the creator's own token, or why it is refused. */
  issue(user: Subject, draft: MissionDraft, options: IssueOptions = {}): Promise<IssueResult> {
    return this.#issuance.issue(user, draft, options);
  }

  /** The draft that re-issues a mission of the user; `null` when it is not theirs. */
  draftFrom(user: Subject, missionId: string): Promise<MissionDraft | null> {
    return this.#issuance.draftFrom(user, missionId);
  }

  /** "Duplicate mission": the source's draft issued again under the creator's authority now. */
  duplicate(
    user: Subject,
    missionId: string,
    overrides: Partial<Pick<MissionDraft, 'name' | 'period' | 'expires_at'>> = {},
    options: IssueOptions = {},
  ): Promise<IssueResult> {
    return this.#issuance.duplicate(user, missionId, overrides, options);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Token: rotate, verify: mission-tokens.ts
  // ───────────────────────────────────────────────────────────────────────────

  /** A new token for the creator; their previous one stops working. */
  rotate(user: Subject, missionId: string, options: IssueOptions = {}): Promise<RotateResult> {
    return this.#tokens.rotate(user, missionId, options);
  }

  /** What a presented Bearer is worth at this instant. */
  verifyToken(bearer: string): Promise<TokenVerification> {
    return this.#tokens.verifyToken(bearer);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Revoke, and the missions on an account: mission-closing.ts
  // ───────────────────────────────────────────────────────────────────────────

  /** The orphaned missions that carry an account, for someone who owns it now. */
  orphanedOn(user: Subject, accountId: string): Promise<OrphanedOnAccount[]> {
    return this.#closing.orphanedOn(user, accountId);
  }

  /** Every mission that carries an account, newest first, for someone who owns it now. */
  onAccount(user: Subject, accountId: string): Promise<MissionOnAccount[]> {
    return this.#closing.onAccount(user, accountId);
  }

  /** The mission refuses everything from now on; every token of every holder is revoked. */
  revoke(user: Subject, missionId: string, options: IssueOptions = {}): Promise<RevokeResult> {
    return this.#closing.revoke(user, missionId, options);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Gate, limits, permissions after issuance: mission-policy-changes.ts
  // ───────────────────────────────────────────────────────────────────────────

  /** The creator edits the gate of one accepted risk after issuance. */
  setGate(
    user: Subject,
    missionId: string,
    riskId: RiskId,
    gate: string,
    /** The set of the line; absent when exactly one set of the mission accepts the risk. */
    resourceSetId?: string,
  ): Promise<SetGateResult> {
    return this.#policy.setGate(user, missionId, riskId, gate, resourceSetId);
  }

  /** The creator changes the limits of accepted risks after issuance. */
  setLimits(
    user: Subject,
    missionId: string,
    edits: readonly LimitEdit[],
  ): Promise<SetLimitsResult> {
    return this.#policy.setLimits(user, missionId, edits);
  }

  /** The lines the creator may add to the mission, each with why it is or is not available. */
  permissionOptions(user: Subject, missionId: string) {
    return this.#policy.permissionOptions(user, missionId);
  }

  /** Shared by a direct edit and the creator's answer to a permission request. */
  changePermissions(user: Subject, missionId: string, raw: unknown) {
    return this.#policy.changePermissions(user, missionId, raw);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Reads for the Missions pages: mission-reads.ts, mission-trust-raises.ts
  // ───────────────────────────────────────────────────────────────────────────

  /** The missions the user can read, newest first. */
  list(user: Subject): Promise<MissionOverview[]> {
    return this.#reads.list(user);
  }

  /** One mission, for its creator or for a current member. */
  get(user: Subject, missionId: string): Promise<MissionDetail | null> {
    return this.#reads.get(user, missionId);
  }

  /** A stored mission as it stands now, for a reader the caller already scoped. */
  standing(
    stored: MissionRecord,
  ): Promise<{ readonly mission: MissionRecord; readonly state: MissionState }> {
    return this.#reads.standing(stored);
  }

  /** The trust-raise proposals of every running mission the user created, for the Now page. */
  trustRaisesFor(user: Subject): Promise<
    {
      readonly mission_id: string;
      readonly mission_name: string;
      readonly offers: readonly TrustRaiseOffer[];
    }[]
  > {
    return this.#trustRaises.trustRaisesFor(user);
  }

  /** "Not now" on a trust-raise proposal; `null` is "not found". */
  snoozeTrustRaise(
    user: Subject,
    missionId: string,
    target: { readonly resource_set_id: string; readonly macro_action_id: string },
  ): Promise<{ readonly ok: true } | null> {
    return this.#trustRaises.snoozeTrustRaise(user, missionId, target);
  }

  /** The one trust-raise proposal "Raise" opens the edit with; `null` otherwise. */
  trustRaiseOffer(
    user: Subject,
    missionId: string,
    target: { readonly resource_set_id: string; readonly macro_action_id: string },
  ): Promise<TrustRaiseOffer | null> {
    return this.#trustRaises.trustRaiseOffer(user, missionId, target);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Shared reads, for the team service and the execution door: mission-lookups.ts
  // ───────────────────────────────────────────────────────────────────────────

  /** The state to report when the store refused a token insert (`MissionLookups`). */
  stateAfterRefusal(missionId: string): Promise<Exclude<MissionState['kind'], 'active'>> {
    return this.#lookups.stateAfterRefusal(missionId);
  }

  /** The mission's state at this instant (the budget's single derivation). */
  stateOf(mission: MissionRecord): Promise<MissionState> {
    return this.#lookups.stateOf(mission);
  }

  /** Who may READ a mission, and as what: its creator, or a current member. */
  access(user: Subject, missionId: string): Promise<MissionAccess | null> {
    return this.#lookups.access(user, missionId);
  }

  /** The bootstrap kit of the mission around one token: its secret or its masked prefix. */
  kitOf(
    mission: MissionRecord,
    token: { secret: string } | { prefix: string },
    known?: readonly MissionDetailAccount[],
  ): Promise<BootstrapKit> {
    return this.#lookups.kitOf(mission, token, known);
  }
}
