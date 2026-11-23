/**
 * One admitted git request and what every part of the door does with it
 * (spec §4.1 ter): the calls it builds, the target it reaches, the answers
 * for a refused or failed call.
 */
import type {
  CallOutcome,
  CallPipeline,
  CallRequest,
  ClientOrigin,
  MissionContext,
} from '@vaubaan/gateway-core';
import type { RegisteredPlugin } from '@vaubaan/plugin-sdk';

import type { Logger } from '../logging';
import { HTTP_BAD_GATEWAY, HTTP_FORBIDDEN } from './constants';
import type { GitTarget } from './upstream';
import { gitText } from './wire';
import { refusalLine, refusalText, resultText } from './words';

/** An admitted git request, about one repository of the mission's service. */
export interface Scope {
  readonly ctx: MissionContext;
  readonly client: ClientOrigin;
  readonly registered: RegisteredPlugin;
  readonly repository: string;
  readonly agentLabel: string | null;
  readonly signal: AbortSignal;
}

function gitCall(scope: Scope, tool: string, args: Record<string, unknown>): CallRequest {
  return {
    tool,
    args,
    channel: 'git',
    agent_label: scope.agentLabel,
    client: scope.client,
    signal: scope.signal,
  };
}

export function fetchCall(scope: Scope, step: 'refs' | 'pack'): CallRequest {
  return gitCall(scope, scope.registered.plugin.gitRemote!.fetchTool, {
    repository: scope.repository,
    step,
  });
}

export function pushCall(scope: Scope, args: Record<string, unknown>): CallRequest {
  return gitCall(scope, scope.registered.plugin.gitRemote!.pushTool, args);
}

/**
 * The target of an admitted call: the mission's account to the plugin's service,
 * the one that holds the repository when the mission carries several (the
 * path names the repository, hence the account: spec §4.1 ter).
 */
export function targetOf(scope: Scope): GitTarget {
  const { plugin } = scope.registered;
  const accounts = scope.ctx.accounts.filter((c) => c.service === plugin.id);
  const holders = accounts.filter((c) =>
    scope.ctx.resources.some(
      // Repository names are case-blind at the services that serve git.
      (r) => r.account_id === c.id && r.ref.toLowerCase() === scope.repository.toLowerCase(),
    ),
  );
  // A lost account gives way to a serving one holding the same repository, as
  // in the resource stage.
  const account =
    accounts.length === 1 ? accounts[0] : (holders.find((c) => c.lost === undefined) ?? holders[0]);
  // The precheck's resource stage refuses a mission without this account, and a
  // repository no account of the mission reaches.
  if (!account) throw new Error('git door: a prechecked call without its account');
  return { plugin, remote: plugin.gitRemote!, account, repository: scope.repository };
}

/** Mission, resource and risk checks of a refs listing; the refusal, audited, or nothing. */
export async function refsRefusal(
  pipeline: CallPipeline,
  logger: Logger,
  scope: Scope,
): Promise<CallOutcome | null> {
  const outcome = await pipeline.precheck(scope.ctx, fetchCall(scope, 'refs'));
  if (outcome) logOutcome(logger, 'git fetch', scope, outcome);
  return outcome;
}

export function logOutcome(
  logger: Logger,
  event: string,
  scope: Scope,
  outcome: CallOutcome,
): void {
  // Arguments are never logged; the audit entry carries their fingerprint.
  logger.info(event, {
    mission_id: scope.ctx.mission.id,
    token_prefix: scope.ctx.token.prefix,
    outcome: outcome.kind,
    refusal_code: outcome.audit.refusal_code,
    arguments_hash: outcome.audit.arguments_hash,
    agent_label: outcome.audit.agent_label,
  });
}

/** One line for a refused call, whatever its kind. */
export function lineOf(outcome: CallOutcome): string {
  switch (outcome.kind) {
    case 'refused':
      return refusalLine(outcome.refusal);
    case 'rejected':
      return outcome.reason;
    case 'failed':
      return outcome.refusal ? refusalLine(outcome.refusal) : outcome.error;
    case 'allowed':
      // Allowed and nothing relayed: the plugin declined (its sentence is the result).
      return resultText(outcome.result) || 'nothing was relayed';
  }
}

/** A refused refs listing: git prints the body under `remote:` before its own error. */
export function refusedListing(outcome: CallOutcome): Response {
  const text =
    outcome.kind === 'refused'
      ? `${refusalLine(outcome.refusal)}\n${refusalText(outcome.refusal).replace(/^Vaubaan: /gm, '')}`
      : lineOf(outcome);
  return gitText(HTTP_FORBIDDEN, text);
}

/** The service did not answer: a 502 naming it, the reason logged. */
export function upstreamFailure(logger: Logger, scope: Scope, what: string): Response {
  const name = scope.registered.plugin.displayName;
  logger.warn('git: the service did not answer', {
    mission_id: scope.ctx.mission.id,
    service: scope.registered.plugin.id,
    error: what,
  });
  return gitText(
    HTTP_BAD_GATEWAY,
    `${name} did not answer this request (${what}). Try again; if it persists, tell the human.`,
  );
}
