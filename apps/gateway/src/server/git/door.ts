/**
 * The git remote — the second door of the execution surface (spec §4.1 bis;
 * ADR gateway-as-git-remote). Host-agnostic `Request → Response`;
 * `src/app/git/[...path]/route.ts` is a one-line adapter.
 *
 *   GET  /git/<repo>.git/info/refs?service=git-upload-pack    refs of a fetch
 *   POST /git/<repo>.git/git-upload-pack                       objects of a fetch
 *   GET  /git/<repo>.git/info/refs?service=git-receive-pack   refs before a push
 *   POST /git/<repo>.git/git-receive-pack                      a push
 *
 * Order of a request:
 *
 *   path        the repository and the endpoint; LFS is answered "not supported"
 *   key         HTTP Basic, the mission key as the password (the user name is
 *               ignored); none → 401 with a Basic challenge, so git asks its
 *               credential helper
 *   admission   the MCP door's own (`MissionAdmission`, one instance): verifier,
 *               401 reasons, `wrong-credential-kind`, the per-mission surface
 *               rate limit shared with `/mcp`
 *   decision    the git pipeline: the same resource, risk and budget stages and
 *               the same audit as `tools/call`, with the git tools of the plugin
 *               (`github__git_fetch`, `github__git_push`)
 *
 * Which request is the call (ADR D3): the requests that only list refs
 * (`info/refs`, a v2 `ls-refs`) are prechecked — a refusal is audited, a pass
 * is not recorded; the request that transfers objects is the audited, counted
 * `github__git_fetch { step: 'pack' }`; a push is one `github__git_push`.
 *
 * The key is never logged and never sent upstream; the provider's credential
 * never comes back. Nothing here imports `next`.
 */
import type {
  CallOutcome,
  CallPipeline,
  CallRequest,
  ClientOrigin,
  MissionContext,
} from '@vaubaan/gateway-core';
import {
  advertisementType,
  encodeAdvertisement,
  GIT_TEMPORARY_REF_PREFIX,
  GitProtocolError,
  parseAdvertisement,
  PktLineReader,
  PktLineError,
  pktLine,
  pktLineText,
  RECEIVE_PACK_SERVICE,
  UPLOAD_PACK_SERVICE,
  type ExecuteContext,
  type GitAccess,
  type PluginRegistry,
  type RegisteredPlugin,
} from '@vaubaan/plugin-sdk';

import type { InstanceConfig } from '../config';
import { isDenial, type MissionAdmission } from '../execution/admission';
import { readAgentLabel } from '../execution/request-meta';
import type { Logger } from '../logging';
import type { PendingRefsRepo } from '../store';
import { parseGitPath, type GitPath } from './paths';
import { GIT_AGENT, Push } from './push';
import {
  callUpstream,
  executeContextFor,
  relayedResponse,
  type GitTarget,
  type RelayJobs,
  type UpstreamDeps,
} from './upstream';
import {
  errPacket,
  gitText,
  HTTP_BAD_GATEWAY,
  HTTP_FORBIDDEN,
  HTTP_METHOD_NOT_ALLOWED,
  HTTP_NOT_FOUND,
  HTTP_TOO_MANY_REQUESTS,
  lfsUnsupported,
  unauthorized,
} from './wire';
import { refusalLine, refusalText } from './words';

const MS_PER_SECOND = 1000;
const HTTP_UNAUTHORIZED = 401;

/** What a push may ask of the door: only what the door implements (ADR D4). */
const PUSH_CAPABILITIES = ['report-status', 'delete-refs', 'side-band-64k', 'quiet'] as const;

export interface GitDoorDeps extends UpstreamDeps {
  readonly config: Pick<InstanceConfig, 'git'>;
  readonly registry: PluginRegistry;
  /** The MCP door's admission: the same instance (`ExecutionDoor.admission`). */
  readonly admission: MissionAdmission;
  /** The git pipeline: the execution door's stages, the relay as upstream stage. */
  readonly pipeline: CallPipeline;
  readonly jobs: RelayJobs;
  readonly pendingRefs: PendingRefsRepo;
  readonly logger: Logger;
}

/** An admitted git request, about one repository of the mission's provider. */
interface Scope {
  readonly ctx: MissionContext;
  readonly client: ClientOrigin;
  readonly registered: RegisteredPlugin;
  readonly repository: string;
  readonly agentLabel: string | null;
  readonly signal: AbortSignal;
}

const TEXT = {
  noKey:
    'This is the git remote of a Vaubaan Gateway. Authenticate with your mission key as the password (any user name), read from VAUBAAN_MISSION_TOKEN by a credential helper; see the setup kit of your mission.',
  unknownKey:
    'The mission key was not recognised, or it stopped working. Check VAUBAAN_MISSION_TOKEN; GET <instance>/mcp/catalog with the key tells why it stopped.',
  smartOnly:
    'This git remote speaks the smart HTTP protocol only; use a git client of 2005 or later.',
  noRemote: 'This instance is not a git remote: no provider of it declares one.',
} as const;

export class GitDoor {
  constructor(private readonly deps: GitDoorDeps) {}

  /** The admission this door uses: the MCP door's own instance (structural test). */
  get admission(): MissionAdmission {
    return this.deps.admission;
  }

  async handle(request: Request): Promise<Response> {
    const path = parseGitPath(new URL(request.url));
    if (!path) return gitText(HTTP_NOT_FOUND, 'Not a git path.');
    if (path.endpoint.kind === 'lfs') return lfsUnsupported();
    const registered = this.deps.registry.gitRemote();
    if (!registered) return gitText(HTTP_NOT_FOUND, TEXT.noRemote);

    const wrong = wrongMethodOrEndpoint(request.method, path);
    if (wrong) return wrong;

    const bearer = bearerOf(request.headers.get('authorization'));
    if (bearer === null) return unauthorized(TEXT.noKey);
    const admitted = await this.deps.admission.admit(request, `Bearer ${bearer}`);
    if (isDenial(admitted)) {
      switch (admitted.denial) {
        case 'cross-origin':
          return gitText(
            HTTP_FORBIDDEN,
            'Cross-origin requests are not accepted on this endpoint.',
          );
        case 'verification-throttled':
        case 'rate-limited': {
          const seconds = Math.max(1, Math.ceil(admitted.retryAfterMs / MS_PER_SECOND));
          return gitText(
            HTTP_TOO_MANY_REQUESTS,
            `Too many requests for this mission; retry in ${seconds} s.`,
            { 'Retry-After': String(seconds) },
          );
        }
        case 'unauthenticated': {
          const reason = admitted.error.reason;
          return unauthorized(reason ? `This key stopped working: ${reason}.` : TEXT.unknownKey);
        }
        case 'refused':
          return gitText(
            HTTP_FORBIDDEN,
            `${refusalLine(admitted.refusal)}\n${admitted.refusal.hint}`,
          );
      }
    }

    const repository = registered.plugin.gitRemote?.repositoryOf(path.repositoryPath) ?? null;
    if (repository === null) {
      return gitText(
        HTTP_NOT_FOUND,
        `'${path.repositoryPath.slice(0, 120)}' is not a repository name.`,
      );
    }
    const label = readAgentLabel(request.headers, undefined);
    const scope: Scope = {
      ctx: admitted.ctx,
      client: admitted.client,
      registered,
      repository,
      agentLabel: label.label,
      signal: AbortSignal.any([
        request.signal,
        AbortSignal.timeout(this.deps.config.git.requestTimeoutSeconds * MS_PER_SECOND),
      ]),
    };

    if (path.endpoint.kind === 'upload-pack' || path.endpoint.kind === 'receive-pack') {
      const probe = await probeAnswer(request, path.endpoint.kind);
      if (probe) return probe;
    }

    switch (path.endpoint.kind) {
      case 'info-refs':
        return path.endpoint.service === RECEIVE_PACK_SERVICE
          ? this.pushAdvertisement(scope)
          : this.fetchAdvertisement(request, scope);
      case 'upload-pack':
        return this.uploadPack(request, scope);
      case 'receive-pack':
        return this.receivePack(request, scope);
      default:
        return gitText(HTTP_NOT_FOUND, TEXT.smartOnly);
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Calls and their checks
  // ───────────────────────────────────────────────────────────────────────────

  private fetchCall(scope: Scope, step: 'refs' | 'pack'): CallRequest {
    const remote = scope.registered.plugin.gitRemote!;
    return {
      tool: remote.fetchTool,
      args: { repository: scope.repository, step },
      channel: 'git',
      agent_label: scope.agentLabel,
      client: scope.client,
      signal: scope.signal,
    };
  }

  /** The target of an admitted call: the mission's connection to the plugin's provider. */
  private targetOf(scope: Scope): GitTarget {
    const { plugin } = scope.registered;
    const connection = scope.ctx.connections.find((c) => c.provider === plugin.id);
    // The precheck's resource stage refuses a mission without this connection.
    if (!connection) throw new Error('git door: a prechecked call without its connection');
    return { plugin, remote: plugin.gitRemote!, connection, repository: scope.repository };
  }

  /** Mission, resource and risk checks of a refs listing; the refusal, audited, or nothing. */
  private async refsRefusal(scope: Scope): Promise<CallOutcome | null> {
    const outcome = await this.deps.pipeline.precheck(scope.ctx, this.fetchCall(scope, 'refs'));
    if (outcome) this.log('git fetch', scope, outcome);
    return outcome;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Fetch
  // ───────────────────────────────────────────────────────────────────────────

  private async fetchAdvertisement(request: Request, scope: Scope): Promise<Response> {
    const refused = await this.refsRefusal(scope);
    if (refused) return refusedAdvertisement(refused);
    return this.relayDirect(scope, 'read', {
      method: 'GET',
      suffix: `/info/refs?service=${UPLOAD_PACK_SERVICE}`,
      headers: request.headers,
      body: null,
    });
  }

  private async uploadPack(request: Request, scope: Scope): Promise<Response> {
    if (!request.body) return errPacket(UPLOAD_PACK_SERVICE, 'an empty fetch request');
    // Protocol v2: the first packet names the command; `ls-refs` only lists refs.
    let body: ReadableStream<Uint8Array> = request.body;
    if (isProtocolV2(request) && !request.headers.get('content-encoding')) {
      const peeked = await peekFirstLine(request.body);
      if (peeked === null)
        return errPacket(UPLOAD_PACK_SERVICE, 'the fetch request could not be read');
      body = peeked.stream;
      if (peeked.line === 'command=ls-refs') {
        const refused = await this.refsRefusal(scope);
        if (refused) return errPacket(UPLOAD_PACK_SERVICE, lineOf(refused));
        return this.relayDirect(scope, 'read', {
          method: 'POST',
          suffix: `/${UPLOAD_PACK_SERVICE}`,
          headers: request.headers,
          body,
        });
      }
    }
    return this.relayDecided(scope, {
      method: 'POST',
      suffix: `/${UPLOAD_PACK_SERVICE}`,
      headers: request.headers,
      body,
    });
  }

  /**
   * The objects of a fetch: one call through the pipeline; the bytes flow from
   * its upstream stage once the call is allowed and counted.
   */
  private async relayDecided(
    scope: Scope,
    request: { method: 'POST'; suffix: string; headers: Headers; body: ReadableStream<Uint8Array> },
  ): Promise<Response> {
    const call = this.fetchCall(scope, 'pack');
    let respond!: (response: Response) => void;
    const responded = new Promise<Response>((resolve) => {
      respond = resolve;
    });
    this.deps.jobs.attach(call, {
      repository: scope.repository,
      access: 'read',
      request,
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
        .then((o) => this.log('git fetch', scope, o))
        .catch((err: unknown) =>
          this.deps.logger.error('git fetch: the audit of a relayed fetch failed', {
            mission_id: scope.ctx.mission.id,
            error: err instanceof Error ? err.name : 'Error',
          }),
        );
      return first.response;
    }
    this.log('git fetch', scope, first.outcome);
    return errPacket(UPLOAD_PACK_SERVICE, lineOf(first.outcome));
  }

  /** A relayed request that is not a call (refs listings, after their precheck). */
  private async relayDirect(
    scope: Scope,
    access: GitAccess,
    request: {
      method: 'GET' | 'POST';
      suffix: string;
      headers: Headers;
      body: ReadableStream<Uint8Array> | null;
    },
  ): Promise<Response> {
    const target = this.targetOf(scope);
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
        return this.upstreamFailure(scope, `HTTP ${answer.status}`);
      }
      return relayedResponse(answer, answer.body);
    } catch (err) {
      return this.upstreamFailure(scope, err instanceof Error ? err.name : 'Error');
    }
  }

  private upstreamFailure(scope: Scope, what: string): Response {
    const name = scope.registered.plugin.displayName;
    this.deps.logger.warn('git: the provider did not answer', {
      mission_id: scope.ctx.mission.id,
      provider: scope.registered.plugin.id,
      error: what,
    });
    return gitText(
      HTTP_BAD_GATEWAY,
      `${name} did not answer this request (${what}). Try again; if it persists, tell the human.`,
    );
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Push
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * The refs before a push: the provider's, minus the gateway's temporary refs,
   * with the capabilities the door implements and nothing else (ADR D4).
   */
  private async pushAdvertisement(scope: Scope): Promise<Response> {
    const refused = await this.refsRefusal(scope);
    if (refused) return refusedAdvertisement(refused);
    const target = this.targetOf(scope);
    let execCtx: ExecuteContext;
    let body: Uint8Array;
    try {
      execCtx = await executeContextFor(this.deps, scope.ctx, target, scope.signal);
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
        return this.upstreamFailure(scope, `HTTP ${answer.status}`);
      }
      body = new Uint8Array(await answer.arrayBuffer());
    } catch (err) {
      return this.upstreamFailure(scope, err instanceof Error ? err.name : 'Error');
    }
    let upstreamAd;
    try {
      upstreamAd = parseAdvertisement(body);
    } catch (err) {
      if (err instanceof GitProtocolError) return this.upstreamFailure(scope, err.name);
      throw err;
    }
    const capabilities = [
      ...PUSH_CAPABILITIES,
      ...upstreamAd.capabilities.filter((c) => c === 'ofs-delta' || c.startsWith('object-format=')),
      `agent=${GIT_AGENT}`,
    ];
    return new Response(
      encodeAdvertisement({
        service: RECEIVE_PACK_SERVICE,
        refs: upstreamAd.refs.filter((r) => !r.name.startsWith(GIT_TEMPORARY_REF_PREFIX)),
        capabilities,
      }),
      {
        status: 200,
        headers: {
          'Content-Type': advertisementType(RECEIVE_PACK_SERVICE),
          'Cache-Control': 'no-cache, no-store',
        },
      },
    );
  }

  private async receivePack(request: Request, scope: Scope): Promise<Response> {
    // Same rule as for a fetch: a mission that cannot read the refs cannot push.
    const refused = await this.refsRefusal(scope);
    if (refused) return errPacket(RECEIVE_PACK_SERVICE, lineOf(refused));
    return new Push(
      {
        config: this.deps.config,
        pipeline: this.deps.pipeline,
        pendingRefs: this.deps.pendingRefs,
        credentials: this.deps.credentials,
        credentialCache: this.deps.credentialCache,
        logger: this.deps.logger,
      },
      {
        request,
        ctx: scope.ctx,
        client: scope.client,
        target: this.targetOf(scope),
        agentLabel: scope.agentLabel,
        signal: scope.signal,
      },
    ).handle();
  }

  private log(event: string, scope: Scope, outcome: CallOutcome): void {
    // Arguments are never logged; the audit entry carries their fingerprint.
    this.deps.logger.info(event, {
      mission_id: scope.ctx.mission.id,
      token_prefix: scope.ctx.token.prefix,
      outcome: outcome.kind,
      refusal_code: outcome.audit.refusal_code,
      arguments_hash: outcome.audit.arguments_hash,
      agent_label: outcome.audit.agent_label,
    });
  }
}

/** `Authorization: Basic <user:key>` → the key; a `Bearer` header is taken as it is. */
export function bearerOf(authorization: string | null): string | null {
  if (!authorization) return null;
  const [scheme = '', value = ''] = authorization.trim().split(/\s+/, 2);
  if (scheme.toLowerCase() === 'bearer') return value || null;
  if (scheme.toLowerCase() !== 'basic' || !value) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(value, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const colon = decoded.indexOf(':');
  const password = colon === -1 ? '' : decoded.slice(colon + 1);
  return password.length > 0 ? password : null;
}

function wrongMethodOrEndpoint(method: string, path: GitPath): Response | null {
  const { endpoint } = path;
  if (endpoint.kind === 'unknown') return gitText(HTTP_NOT_FOUND, TEXT.smartOnly);
  if (endpoint.kind === 'info-refs') {
    if (endpoint.service === null) return gitText(HTTP_FORBIDDEN, TEXT.smartOnly);
    return method === 'GET' ? null : gitText(HTTP_METHOD_NOT_ALLOWED, 'Use GET.', { Allow: 'GET' });
  }
  return method === 'POST'
    ? null
    : gitText(HTTP_METHOD_NOT_ALLOWED, 'Use POST.', { Allow: 'POST' });
}

/** The body of git's probe: a flush packet alone. */
const PROBE_BODY = '0000';

/**
 * Before a request body larger than `http.postBuffer`, git sends a probe — a
 * POST whose body is a flush packet alone — to check that the credentials
 * work before streaming (git's remote-curl `probe_rpc`). It asks for nothing:
 * it is answered `200` with an empty body, after the admission, and is
 * neither decided nor audited.
 */
async function probeAnswer(
  request: Request,
  endpoint: 'upload-pack' | 'receive-pack',
): Promise<Response | null> {
  if (request.headers.get('content-length') !== String(PROBE_BODY.length)) return null;
  const body = await request.clone().text();
  if (body !== PROBE_BODY) return null;
  const service = endpoint === 'upload-pack' ? UPLOAD_PACK_SERVICE : RECEIVE_PACK_SERVICE;
  return new Response(null, {
    status: 200,
    headers: {
      'Content-Type': `application/x-${service}-result`,
      'Cache-Control': 'no-cache, no-store',
    },
  });
}

function isProtocolV2(request: Request): boolean {
  return /(^|:)version=2(:|$)/.test(request.headers.get('git-protocol') ?? '');
}

/** The first pkt-line of a body as text, and the body again, whole. */
async function peekFirstLine(
  body: ReadableStream<Uint8Array>,
): Promise<{ readonly line: string | null; readonly stream: ReadableStream<Uint8Array> } | null> {
  const reader = new PktLineReader(body);
  try {
    const first = await reader.read();
    const head =
      first?.kind === 'data'
        ? pktLine(first.payload)
        : first
          ? new TextEncoder().encode(specialOf(first.kind))
          : new Uint8Array(0);
    const rest = reader.rest();
    const restReader = rest.getReader();
    let headSent = false;
    return {
      line: first ? pktLineText(first) : null,
      stream: new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (!headSent) {
            headSent = true;
            if (head.length > 0) {
              controller.enqueue(head);
              return;
            }
          }
          const { done, value } = await restReader.read();
          if (done) controller.close();
          else controller.enqueue(value);
        },
        cancel(reason) {
          return restReader.cancel(reason);
        },
      }),
    };
  } catch (err) {
    if (err instanceof PktLineError) return null;
    throw err;
  }
}

function specialOf(kind: 'flush' | 'delim' | 'response-end'): string {
  return kind === 'flush' ? '0000' : kind === 'delim' ? '0001' : '0002';
}

/** One line for a refused call, whatever its kind. */
function lineOf(outcome: CallOutcome): string {
  switch (outcome.kind) {
    case 'refused':
      return refusalLine(outcome.refusal);
    case 'rejected':
      return outcome.reason;
    case 'failed':
      return outcome.refusal ? refusalLine(outcome.refusal) : outcome.error;
    case 'allowed':
      return 'allowed';
  }
}

/** A refused refs listing: git prints the body under `remote:` before its own error. */
function refusedAdvertisement(outcome: CallOutcome): Response {
  const text =
    outcome.kind === 'refused'
      ? `${refusalLine(outcome.refusal)}\n${refusalText(outcome.refusal).replace(/^Vaubaan: /gm, '')}`
      : lineOf(outcome);
  return gitText(HTTP_FORBIDDEN, text);
}
