/**
 * The push side of the git remote (spec §4.1 ter; ADR gateway-as-git-remote
 * D4): the refs before a push, and the push itself (`push.ts`).
 *
 * Both ask first whether the mission may push at all — whether its policy
 * holds the plugin's `pushRisk` — so that a mission that cannot push gets
 * neither the receive-pack advertisement nor a write credential minted for it.
 */
import type { CallPipeline } from '@vaubaan/gateway-core';
import {
  advertisementType,
  encodeAdvertisement,
  ExecutorRefusal,
  GitProtocolError,
  parseAdvertisement,
  RECEIVE_PACK_SERVICE,
} from '@vaubaan/plugin-sdk';

import type { Logger } from '../logging';
import { GIT_AGENT, HTTP_FORBIDDEN, HTTP_UNAUTHORIZED, NO_CACHE } from './constants';
import type { InFlightPushes } from './in-flight';
import { Push, type PushDeps } from './push';
import {
  lineOf,
  logOutcome,
  pushCall,
  refsRefusal,
  refusedListing,
  targetOf,
  upstreamFailure,
  type Scope,
} from './scope';
import { isTemporaryRef, type TemporaryRefsDeps } from './temporary-refs';
import { callUpstream, executeContextFor } from './upstream';
import { errPacket, gitText } from './wire';

/** What a push may ask of the door: only what the door implements (ADR D4 bis). */
const PUSH_CAPABILITIES = ['report-status', 'delete-refs', 'side-band-64k', 'quiet'] as const;

export interface PushSideDeps extends TemporaryRefsDeps {
  readonly pipeline: CallPipeline;
  readonly inFlight: InFlightPushes;
  readonly logger: Logger;
}

export class PushSide {
  constructor(private readonly deps: PushSideDeps) {}

  /**
   * The mission's permission to push at all; the refusal, audited, as git
   * reads it before any write credential exists, or `null`.
   */
  private async mayNotPush(scope: Scope): Promise<string | null> {
    const risk = scope.registered.plugin.gitRemote!.pushRisk;
    if (scope.ctx.policy.some((entry) => entry.risk_id === risk)) return null;
    const reason = `permission ${risk} is not in this mission: it cannot push to this repository`;
    const outcome = await this.deps.pipeline.reject(
      scope.ctx,
      pushCall(scope, { repository: scope.repository }),
      reason,
    );
    logOutcome(this.deps.logger, 'git push', scope, outcome);
    return reason;
  }

  /**
   * The refs before a push: the provider's, minus the gateway's temporary refs,
   * with the capabilities the door implements and nothing else.
   */
  async advertisement(scope: Scope): Promise<Response> {
    const refused = await refsRefusal(this.deps.pipeline, this.deps.logger, scope);
    if (refused) return refusedListing(refused);
    const cannot = await this.mayNotPush(scope);
    if (cannot) return gitText(HTTP_FORBIDDEN, cannot);
    const target = targetOf(scope);
    let body: Uint8Array;
    try {
      const execCtx = await executeContextFor(this.deps, scope.ctx, target, scope.signal);
      const upstream = await target.remote.upstream(execCtx, target.repository, 'write');
      const answer = await callUpstream(execCtx, upstream, {
        method: 'GET',
        suffix: `/info/refs?service=${RECEIVE_PACK_SERVICE}`,
        headers: new Headers({ accept: advertisementType(RECEIVE_PACK_SERVICE) }),
        body: null,
        signal: scope.signal,
      });
      if (!answer.ok) {
        await answer.body?.cancel();
        if (answer.status === HTTP_UNAUTHORIZED) {
          await this.deps.credentialCache.drop(target.connection.id);
        }
        return upstreamFailure(this.deps.logger, scope, `HTTP ${answer.status}`);
      }
      body = new Uint8Array(await answer.arrayBuffer());
    } catch (err) {
      // The plugin declined (the account lacks the permission a push needs).
      if (err instanceof ExecutorRefusal) return gitText(HTTP_FORBIDDEN, err.message);
      return upstreamFailure(this.deps.logger, scope, err instanceof Error ? err.name : 'Error');
    }
    let upstreamAd;
    try {
      upstreamAd = parseAdvertisement(body);
    } catch (err) {
      if (err instanceof GitProtocolError)
        return upstreamFailure(this.deps.logger, scope, err.name);
      throw err;
    }
    // Object ids are SHA-1 throughout the door: a repository in another format is refused.
    const format = upstreamAd.capabilities.find((c) => c.startsWith('object-format='));
    if (format !== undefined && format !== 'object-format=sha1') {
      return gitText(
        HTTP_FORBIDDEN,
        `This repository uses ${format.slice('object-format='.length)} object ids; the git remote supports SHA-1 repositories only.`,
      );
    }
    const capabilities = [
      ...PUSH_CAPABILITIES,
      ...upstreamAd.capabilities.filter((c) => c === 'ofs-delta' || c === 'object-format=sha1'),
      `agent=${GIT_AGENT}`,
    ];
    return new Response(
      encodeAdvertisement({
        service: RECEIVE_PACK_SERVICE,
        refs: upstreamAd.refs.filter((r) => !isTemporaryRef(r.name)),
        capabilities,
      }),
      {
        status: 200,
        headers: { 'Content-Type': advertisementType(RECEIVE_PACK_SERVICE), ...NO_CACHE },
      },
    );
  }

  /** `POST git-receive-pack`. */
  async receivePack(request: Request, scope: Scope): Promise<Response> {
    // Same rule as for a fetch: a mission that cannot read the refs cannot push.
    const refused = await refsRefusal(this.deps.pipeline, this.deps.logger, scope);
    if (refused) return errPacket(RECEIVE_PACK_SERVICE, lineOf(refused));
    const cannot = await this.mayNotPush(scope);
    if (cannot) return errPacket(RECEIVE_PACK_SERVICE, cannot);
    const deps: PushDeps = this.deps;
    return new Push(deps, {
      request,
      ctx: scope.ctx,
      client: scope.client,
      target: targetOf(scope),
      agentLabel: scope.agentLabel,
      signal: scope.signal,
    }).handle();
  }
}
