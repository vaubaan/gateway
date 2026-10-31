/**
 * The fetch side of the git remote (spec §4.1 ter; ADR gateway-as-git-remote
 * D3): a clone or fetch relayed to the provider.
 *
 *   GET  info/refs?service=git-upload-pack   prechecked (refs only), relayed with
 *                                            the gateway's temporary refs hidden
 *   POST git-upload-pack, v2 `ls-refs`       prechecked, relayed, temporary refs hidden
 *   POST git-upload-pack, anything else      one audited, counted call
 *                                            (`github__git_fetch { step: 'pack' }`);
 *                                            the bytes flow from its upstream stage
 *
 * A v2 request head is read strictly (`readV2RequestHead`): exactly one
 * `command=` line, or the request is refused — the door does not rely on the
 * provider to refuse a second command. A gzip-encoded v2 body is not read
 * and is counted as a transfer (fail closed).
 */
import type { CallPipeline } from '@vaubaan/gateway-core';
import { ExecutorRefusal } from '@vaubaan/plugin-sdk';
import {
  advertisementType,
  advertisementWithout,
  GitProtocolError,
  lsRefsWithout,
  PktLineReader,
  prependChunk,
  readV2RequestHead,
  UPLOAD_PACK_SERVICE,
  type GitAccess,
} from '@vaubaan/plugin-sdk/git';

import type { Logger } from '../logging';
import { HTTP_FORBIDDEN, HTTP_UNAUTHORIZED, MAX_REF_LISTING_BYTES, NO_CACHE } from './constants';
import {
  fetchCall,
  lineOf,
  logOutcome,
  refsRefusal,
  refusedListing,
  targetOf,
  upstreamFailure,
  type Scope,
} from './scope';
import { isTemporaryRef } from './temporary-refs';
import { callUpstream, executeContextFor, type RelayJobs, type UpstreamDeps } from './upstream';
import { errPacket, gitText } from './wire';

export interface FetchDeps extends UpstreamDeps {
  readonly pipeline: CallPipeline;
  readonly jobs: RelayJobs;
  readonly logger: Logger;
}

interface Relayed {
  readonly method: 'GET' | 'POST';
  readonly suffix: string;
  readonly headers: Headers;
  readonly body: ReadableStream<Uint8Array> | null;
}

export class FetchSide {
  constructor(private readonly deps: FetchDeps) {}

  /** `GET info/refs?service=git-upload-pack`. */
  async advertisement(request: Request, scope: Scope): Promise<Response> {
    const refused = await refsRefusal(this.deps.pipeline, this.deps.logger, scope);
    if (refused) return refusedListing(refused);
    return this.relayListing(
      scope,
      {
        method: 'GET',
        suffix: `/info/refs?service=${UPLOAD_PACK_SERVICE}`,
        headers: request.headers,
        body: null,
      },
      (body) => advertisementWithout(body, isTemporaryRef),
    );
  }

  /** `POST git-upload-pack`. */
  async uploadPack(request: Request, scope: Scope): Promise<Response> {
    if (!request.body) return errPacket(UPLOAD_PACK_SERVICE, 'an empty fetch request');
    const relayed: Relayed = {
      method: 'POST',
      suffix: `/${UPLOAD_PACK_SERVICE}`,
      headers: request.headers,
      body: request.body,
    };
    if (!isProtocolV2(request) || request.headers.get('content-encoding')) {
      return this.relayDecided(scope, relayed);
    }
    const reader = new PktLineReader(request.body);
    let command: string;
    let body: ReadableStream<Uint8Array>;
    try {
      const head = await readV2RequestHead(reader);
      command = head.command;
      body = prependChunk(head.bytes, reader.rest());
    } catch (err) {
      if (!(err instanceof GitProtocolError)) throw err;
      const reason = `this fetch could not be read: ${err.message}`;
      const outcome = await this.deps.pipeline.reject(scope.ctx, fetchCall(scope, 'pack'), reason);
      logOutcome(this.deps.logger, 'git fetch', scope, outcome);
      return errPacket(UPLOAD_PACK_SERVICE, reason);
    }
    if (command === 'ls-refs') {
      const refused = await refsRefusal(this.deps.pipeline, this.deps.logger, scope);
      if (refused) return errPacket(UPLOAD_PACK_SERVICE, lineOf(refused));
      return this.relayListing(scope, { ...relayed, body }, (bytes) =>
        lsRefsWithout(bytes, isTemporaryRef),
      );
    }
    return this.relayDecided(scope, { ...relayed, body });
  }

  /**
   * The objects of a fetch: one call through the pipeline; the bytes flow from
   * its upstream stage once the call is allowed and counted.
   */
  private async relayDecided(scope: Scope, request: Relayed): Promise<Response> {
    const call = fetchCall(scope, 'pack');
    let respond!: (response: Response) => void;
    const responded = new Promise<Response>((resolve) => {
      respond = resolve;
    });
    this.deps.jobs.attach(call, {
      repository: scope.repository,
      access: 'read',
      request: { ...request, method: 'POST' },
      signal: scope.signal,
      respond,
    });
    const outcome = this.deps.pipeline.execute(scope.ctx, call);
    const first = await Promise.race([
      responded.then((response) => ({ response }) as const),
      outcome.then((o) => ({ outcome: o }) as const),
    ]);
    if ('response' in first) {
      outcome
        .then((o) => logOutcome(this.deps.logger, 'git fetch', scope, o))
        .catch((err: unknown) =>
          this.deps.logger.error('git fetch: the audit of a relayed fetch failed', {
            mission_id: scope.ctx.mission.id,
            error: err instanceof Error ? err.name : 'Error',
          }),
        );
      return first.response;
    }
    logOutcome(this.deps.logger, 'git fetch', scope, first.outcome);
    return errPacket(UPLOAD_PACK_SERVICE, lineOf(first.outcome));
  }

  /**
   * A ref listing (not a call): relayed after its precheck, read whole —
   * bounded by `MAX_REF_LISTING_BYTES` — so that `filter` can hide the
   * gateway's temporary refs.
   */
  private async relayListing(
    scope: Scope,
    request: Relayed,
    filter: (body: Uint8Array) => Uint8Array,
  ): Promise<Response> {
    const access: GitAccess = 'read';
    const target = targetOf(scope);
    const attempt = async (): Promise<Response> => {
      const execCtx = await executeContextFor(this.deps, scope.ctx, target, scope.signal);
      const upstream = await target.remote.upstream(execCtx, target.repository, access);
      return callUpstream(execCtx, upstream, { ...request, signal: scope.signal });
    };
    try {
      let answer = await attempt();
      if (answer.status === HTTP_UNAUTHORIZED && request.body === null) {
        // A cached token the provider no longer takes: drop it and mint once more.
        await answer.body?.cancel();
        await this.deps.credentialCache.drop(target.connection.id);
        answer = await attempt();
      }
      if (!answer.ok) {
        await answer.body?.cancel();
        return upstreamFailure(this.deps.logger, scope, `HTTP ${answer.status}`);
      }
      const body = await readBounded(answer, MAX_REF_LISTING_BYTES);
      if (body === null) {
        return gitText(
          HTTP_FORBIDDEN,
          `This repository lists more refs than the git remote reads (${MAX_REF_LISTING_BYTES / 1024 / 1024} MiB).`,
        );
      }
      let filtered: Uint8Array;
      try {
        filtered = filter(body);
      } catch (err) {
        if (err instanceof GitProtocolError)
          return upstreamFailure(this.deps.logger, scope, err.name);
        throw err;
      }
      const type = answer.headers.get('content-type') ?? advertisementType(UPLOAD_PACK_SERVICE);
      return new Response(new Uint8Array(filtered), {
        status: answer.status,
        headers: { 'Content-Type': type, ...NO_CACHE },
      });
    } catch (err) {
      if (err instanceof ExecutorRefusal) return gitText(HTTP_FORBIDDEN, err.message);
      return upstreamFailure(this.deps.logger, scope, err instanceof Error ? err.name : 'Error');
    }
  }
}

/** The body of `response`, or `null` past `max` bytes (the rest is not read). */
async function readBounded(response: Response, max: number): Promise<Uint8Array | null> {
  if (!response.body) return new Uint8Array(0);
  const parts: Uint8Array[] = [];
  let total = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function isProtocolV2(request: Request): boolean {
  return /(^|:)version=2(:|$)/.test(request.headers.get('git-protocol') ?? '');
}
