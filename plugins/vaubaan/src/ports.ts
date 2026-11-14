/**
 * What the host hands the `vaubaan` plugin: the whole of what it can do.
 *
 * ADR : docs/decisions/platform-management-is-a-plugin-on-the-execution-door.md.
 *
 * A plugin knows neither the mission nor the budget, and this one is no
 * exception in what it is *given*: seven acts, each a function of the caller
 * and the call's arguments, implemented by the host over its mission service.
 * There is no port to answer a request, open a gate, extend a budget, reset a
 * period, connect, share or revoke an account, or call another service's tool:
 * none of that is reachable from here, whatever the arguments say. The host
 * builds the ports as plain objects of closures and checks, at every call,
 * that the caller never acts on itself (`self-not-allowed`), that a mission
 * issued here carries no Vaubaan account (`vaubaan-account-not-allowed`) and
 * that the key is the creator's own or a machine key
 * (`teammate-key-not-allowed`).
 *
 * The answers are the JSON the management door published (snake_case, an
 * agent reads them); the host writes them, so the mission module's own rules
 * — what a macro-action yields, why a mission is orphaned — are never restated
 * in a plugin.
 */

import type { ExecuteContext, McpToolResult } from '@vaubaan/plugin-sdk';

import type { VaubaanActName } from './identity.ts';

/** Who calls: the mission whose key made the call, and its creator. */
export interface VaubaanCaller {
  /** The calling mission. It never rotates or revokes itself here. */
  readonly missionId: string;
  /** Its creator: every act is done in their name, within their authority and never beyond. */
  readonly userId: string;
  /**
   * The person holding the key that made the call; `null` for a machine key
   * (named token), which the creator made. A teammate's key is refused: a
   * teammate never acts in the creator's name beyond the mission's own calls.
   */
  readonly holderUserId: string | null;
}

/** A "no", in the shape of the execution door's refusals: a code, a sentence, what to do. */
export interface VaubaanRefusal {
  readonly code: string;
  readonly message: string;
  readonly hint: string;
  readonly [field: string]: unknown;
}

export type VaubaanAnswer =
  | { readonly ok: true; readonly data: object }
  | { readonly ok: false; readonly refusal: VaubaanRefusal };

/** One act: the caller and the call's arguments, as the agent sent them (the host reads them). */
export type VaubaanAct = (
  caller: VaubaanCaller,
  args: Readonly<Record<string, unknown>>,
) => Promise<VaubaanAnswer>;

/** The seven acts, keyed as `ACT` names them. */
export type VaubaanPorts = { readonly [A in VaubaanActName]: VaubaanAct };

/** The keys of `VaubaanPorts`: the whole of what the plugin is given. */
export const VAUBAAN_PORT_NAMES = [
  'listMyConnections',
  'getCatalog',
  'listMyMissions',
  'previewPolicy',
  'issueMission',
  'rotateMissionToken',
  'revokeMission',
] as const satisfies readonly VaubaanActName[];

/**
 * The context of one allowed call, as the host hands it to the execute it
 * composed: the SDK's, plus the caller. Only the host builds it; a plugin
 * loaded through the SDK never receives a caller.
 */
export interface VaubaanExecuteContext extends ExecuteContext {
  readonly caller: VaubaanCaller;
}

/** The `execute` the host binds to its ports (`createVaubaanExecute`). */
export type VaubaanHostExecute = (
  ctx: VaubaanExecuteContext,
  tool: string,
  args: Readonly<Record<string, unknown>>,
) => Promise<McpToolResult>;
