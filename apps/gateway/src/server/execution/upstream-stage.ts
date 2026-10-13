/**
 * Upstream stage — decrypt the connection's credential in memory, forward the
 * call through the plugin, release (spec §2.4 "the executor never sees a
 * provider credential").
 *
 * The credential comes from the connections' `CredentialBroker` only
 * (handbook connections, "Credentials and refresh"): `resolve()` decrypts
 * and refreshes an OAuth token about to expire; `refresh()` forces a refresh
 * and marks the connection `expired` when the provider rejects it. This
 * module never reads a sealed blob.
 *
 * When the provider answers that the credential is not valid (HTTP 401,
 * surfaced by the plugin as `UpstreamAuthError`):
 *
 *   1. the derived credentials cached for the connection are dropped; if
 *      there were any, the call is retried once with the same stored
 *      credential (the rejected one may have been a cached installation
 *      token, not the connection's credential);
 *   2. otherwise, or if that retry is rejected too, the broker refreshes and
 *      the call is retried once;
 *   3. a rejected refresh (the broker has then marked the connection
 *      `expired`), or a connection that is no longer `active`, ends as the
 *      `connection-unavailable` refusal, thrown as `UpstreamRefusalError`.
 *
 * A 403 is NOT treated as a dead credential: the provider recognised the
 * credential and refused that action (a permission the company's app lacks, a
 * secondary rate limit). Expiring the connection on it would stop every
 * mission of that connection for a call that was merely not permitted; it is
 * reported as an ordinary upstream failure, naming the provider's answer.
 */
import {
  isUnavailableConnectionStatus,
  refuse,
  UpstreamRefusalError,
  type CallRequest,
  type CallTarget,
  type ConnectionStatus,
  type MissionContext,
  type UpstreamStage,
} from '@vaubaan/gateway-core';
import { UpstreamAuthError } from '@vaubaan/shared';

import {
  ConnectionUnavailableError,
  type CredentialBroker,
  type ResolvedCredential,
} from '../connections';
import type { Logger } from '../logging';
import type { ConnectionCredentialCache } from './credential-cache';

const HTTP_UNAUTHORIZED = 401;

export interface UpstreamStageDeps {
  readonly credentials: Pick<CredentialBroker, 'resolve' | 'refresh' | 'contextOf'>;
  readonly credentialCache: ConnectionCredentialCache;
  readonly logger: Logger;
}

/** The provider said the credential itself is not valid (as opposed to "not allowed"). */
function credentialRejected(err: unknown): err is UpstreamAuthError {
  return err instanceof UpstreamAuthError && err.upstreamStatus === HTTP_UNAUTHORIZED;
}

export function createUpstreamStage(deps: UpstreamStageDeps): UpstreamStage {
  function forward(
    resolved: ResolvedCredential,
    ctx: MissionContext,
    call: CallRequest,
    target: CallTarget,
  ) {
    return resolved.plugin.execute(
      {
        ...deps.credentials.contextOf(resolved),
        resources: ctx.resources.filter((r) => r.connection_id === target.connection.id),
        agentLabel: call.agent_label,
        credentialCache: deps.credentialCache.scopeFor(resolved.connection),
      },
      call.tool,
      call.args,
    );
  }

  /** Maps a broker failure to the refusal the agent reads, or returns the error untouched. */
  async function asUnavailable(err: unknown, target: CallTarget): Promise<unknown> {
    const { connection } = target;
    let status: ConnectionStatus | 'missing' | null = null;
    if (err instanceof ConnectionUnavailableError) status = err.connectionStatus;
    // A rejected refresh: the broker marked the connection `expired` before throwing.
    else if (err instanceof UpstreamAuthError) status = 'expired';
    if (status === null || status === 'missing' || !isUnavailableConnectionStatus(status)) {
      return err;
    }
    await deps.credentialCache.drop(connection.id);
    return new UpstreamRefusalError(
      refuse.connectionUnavailable({
        connection: { id: connection.id, name: connection.display_name },
        status,
        owner: connection.owner,
      }),
      err instanceof Error ? err.message : undefined,
    );
  }

  return {
    async execute(ctx, call, target): Promise<unknown> {
      const connectionId = target.connection.id;
      let resolved: ResolvedCredential;
      try {
        resolved = await deps.credentials.resolve(connectionId);
      } catch (err) {
        throw await asUnavailable(err, target);
      }

      try {
        return await forward(resolved, ctx, call, target);
      } catch (err) {
        if (!credentialRejected(err)) throw err;
        deps.logger.warn('upstream rejected the credential', {
          connection_id: connectionId,
          provider: target.connection.provider,
          tool: call.tool,
        });
      }

      if ((await deps.credentialCache.drop(connectionId)) > 0) {
        try {
          return await forward(resolved, ctx, call, target);
        } catch (err) {
          if (!credentialRejected(err)) throw err;
        }
      }

      let refreshed: ResolvedCredential;
      try {
        refreshed = await deps.credentials.refresh(connectionId);
      } catch (err) {
        throw await asUnavailable(err, target);
      }
      // A second rejection right after a successful refresh is final for this call;
      // the next call starts over and the broker decides the connection's fate.
      return forward(refreshed, ctx, call, target);
    },
  };
}
