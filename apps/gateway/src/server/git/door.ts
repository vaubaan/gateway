/**
 * The git remote — the second door of the execution surface (spec §4.1 ter;
 * ADR gateway-as-git-remote, protocol-doors-belong-to-the-host).
 * Host-agnostic `Request → Response`; `src/app/git/[...path]/route.ts` is a
 * one-line adapter.
 *
 *   GET  /git/<service>/<repo>.git/info/refs?service=git-upload-pack    refs of a fetch    (fetch.ts)
 *   POST /git/<service>/<repo>.git/git-upload-pack                       a fetch            (fetch.ts)
 *   GET  /git/<service>/<repo>.git/info/refs?service=git-receive-pack   refs before a push (push-side.ts)
 *   POST /git/<service>/<repo>.git/git-receive-pack                      a push             (push-side.ts, push.ts)
 *
 * Order of a request, here:
 *
 *   path        the service, the repository and the endpoint; LFS is
 *               answered "not supported"
 *   service    the plugin the `<service>` segment names, if it declares a
 *               git remote (`PluginRegistry.gitRemoteOf`); else 404. Whether
 *               the mission holds an account on it is the resource stage's
 *               call, decided and audited like any call
 *   key         HTTP Basic, the mission key as the password (the user name is
 *               ignored); none → 401 with a Basic challenge, so git asks its
 *               credential helper
 *   admission   the MCP door's own (`MissionAdmission`, one instance): verifier,
 *               401 reasons, `wrong-credential-kind`, the per-mission surface
 *               rate limit shared with `/mcp`
 *   probe       git's credential probe (a flush packet alone) is answered empty
 *
 * The key is never logged and never sent upstream; the service's credential
 * never comes back. Nothing here imports `next`.
 */
import type { CallPipeline } from '@vaubaan/gateway-core';
import { type PluginRegistry } from '@vaubaan/plugin-sdk';
import { RECEIVE_PACK_SERVICE, UPLOAD_PACK_SERVICE } from '@vaubaan/plugin-sdk/git';

import type { InstanceConfig } from '../config';
import { isDenial, type AdmissionDenial, type MissionAdmission } from '../execution/admission';
import { readAgentLabel } from '../execution/request-meta';
import type { Logger } from '../logging';
import type { PendingRefsRepo } from '../store';
import {
  HTTP_FORBIDDEN,
  HTTP_METHOD_NOT_ALLOWED,
  HTTP_NOT_FOUND,
  HTTP_TOO_MANY_REQUESTS,
  MS_PER_SECOND,
  NO_CACHE,
} from './constants';
import { FetchSide } from './fetch';
import type { InFlightPushes } from './in-flight';
import { GIT_DOOR_SEGMENT, parseGitPath, type GitPath } from './paths';
import { PushSide } from './push-side';
import type { Scope } from './scope';
import type { PluginCallGate } from '../plugins/call-gate';
import type { RelayJobs, UpstreamDeps } from './upstream';
import { gitText, lfsUnsupported, unauthorized } from './wire';
import { oneLine, refusalLine } from './words';

export interface GitDoorDeps extends UpstreamDeps {
  readonly config: Pick<InstanceConfig, 'git'>;
  readonly registry: PluginRegistry;
  /** The MCP door's admission: the same instance (`ExecutionDoor.admission`). */
  readonly admission: MissionAdmission;
  /** Holds the service against a swap of its plugin's version; absent: nothing held. */
  readonly callGate?: PluginCallGate;
  /** The git pipeline: the execution door's stages, the relay as upstream stage. */
  readonly pipeline: CallPipeline;
  readonly jobs: RelayJobs;
  readonly pendingRefs: PendingRefsRepo;
  readonly inFlight: InFlightPushes;
  readonly logger: Logger;
}

const TEXT = {
  noKey:
    'This is the git remote of a Vaubaan Gateway. Authenticate with your mission key as the password (any user name), read from VAUBAAN_MISSION_TOKEN by a credential helper; see the setup kit of your mission.',
  unknownKey:
    'The mission key was not recognised, or it stopped working. Check VAUBAAN_MISSION_TOKEN; GET <instance>/mcp/catalog with the key tells why it stopped.',
  smartOnly:
    'This git remote speaks the smart HTTP protocol only; use a git client of 2005 or later.',
  noService:
    'A git remote path names its service first: <instance>/git/<service>/<owner>/<repo>.git. Take the setup kit of your mission again.',
} as const;

/** The 404 of a `<service>` segment that names no plugin of this instance serving git. */
function noRemoteFor(service: string, registry: PluginRegistry): string {
  const known = registry.get(service);
  const what = known
    ? `${known.plugin.displayName} is not served as a git remote by this instance`
    : `'${oneLine(service.slice(0, 60))}' is not a service of this instance`;
  const served = registry.gitRemotes().map((r) => `${GIT_DOOR_SEGMENT}${r.plugin.id}/`);
  return `${what}. Git remotes here: ${served.length > 0 ? served.join(', ') : 'none'}. ${TEXT.noService}`;
}

export class GitDoor {
  private readonly fetchSide: FetchSide;
  private readonly pushSide: PushSide;

  constructor(private readonly deps: GitDoorDeps) {
    this.fetchSide = new FetchSide(deps);
    this.pushSide = new PushSide(deps);
  }

  /** The admission this door uses: the MCP door's own instance (structural test). */
  get admission(): MissionAdmission {
    return this.deps.admission;
  }

  async handle(request: Request): Promise<Response> {
    const path = parseGitPath(new URL(request.url));
    if (!path || path.service === '' || !this.deps.callGate) return this.serve(request);
    // One version of the plugin for the whole exchange (`plugins/call-gate.ts`).
    const release = await this.deps.callGate.enter(path.service);
    try {
      return await this.serve(request);
    } finally {
      release();
    }
  }

  private async serve(request: Request): Promise<Response> {
    const path = parseGitPath(new URL(request.url));
    if (!path) return gitText(HTTP_NOT_FOUND, 'Not a git path.');
    if (path.endpoint.kind === 'lfs') return lfsUnsupported();
    if (path.service === '') return gitText(HTTP_NOT_FOUND, TEXT.noService);
    const registered = this.deps.registry.gitRemoteOf(path.service);
    if (!registered) {
      return gitText(HTTP_NOT_FOUND, noRemoteFor(path.service, this.deps.registry));
    }

    const wrong = wrongMethodOrEndpoint(request.method, path);
    if (wrong) return wrong;

    const bearer = bearerOf(request.headers.get('authorization'));
    if (bearer === null) return unauthorized(TEXT.noKey);
    const admitted = await this.deps.admission.admit(request, `Bearer ${bearer}`);
    if (isDenial(admitted)) return denialAnswer(admitted);

    const repository = registered.plugin.gitRemote?.repositoryOf(path.repositoryPath) ?? null;
    if (repository === null) {
      return gitText(
        HTTP_NOT_FOUND,
        `'${path.repositoryPath.slice(0, 120)}' is not a repository name.`,
      );
    }
    const scope: Scope = {
      ctx: admitted.ctx,
      client: admitted.client,
      registered,
      repository,
      agentLabel: readAgentLabel(request.headers, undefined).label,
      signal: AbortSignal.any([
        request.signal,
        AbortSignal.timeout(this.deps.config.git.requestTimeoutSeconds * MS_PER_SECOND),
      ]),
    };

    switch (path.endpoint.kind) {
      case 'info-refs':
        return path.endpoint.service === RECEIVE_PACK_SERVICE
          ? this.pushSide.advertisement(scope)
          : this.fetchSide.advertisement(request, scope);
      case 'upload-pack':
        return (
          (await probeAnswer(request, UPLOAD_PACK_SERVICE)) ??
          this.fetchSide.uploadPack(request, scope)
        );
      case 'receive-pack':
        return (
          (await probeAnswer(request, RECEIVE_PACK_SERVICE)) ??
          this.pushSide.receivePack(request, scope)
        );
      default:
        return gitText(HTTP_NOT_FOUND, TEXT.smartOnly);
    }
  }
}

function denialAnswer(denial: AdmissionDenial): Response {
  switch (denial.denial) {
    case 'cross-origin':
      return gitText(HTTP_FORBIDDEN, 'Cross-origin requests are not accepted on this endpoint.');
    case 'rate-limited': {
      const seconds = Math.max(1, Math.ceil(denial.retryAfterMs / MS_PER_SECOND));
      return gitText(
        HTTP_TOO_MANY_REQUESTS,
        `Too many requests for this mission; retry in ${seconds} s.`,
        { 'Retry-After': String(seconds) },
      );
    }
    case 'unauthenticated': {
      const reason = denial.error.reason;
      return unauthorized(reason ? `This key stopped working: ${reason}.` : TEXT.unknownKey);
    }
    case 'refused':
      return gitText(HTTP_FORBIDDEN, `${refusalLine(denial.refusal)}\n${denial.refusal.hint}`);
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
async function probeAnswer(request: Request, service: string): Promise<Response | null> {
  if (request.headers.get('content-length') !== String(PROBE_BODY.length)) return null;
  const body = await request.clone().text();
  if (body !== PROBE_BODY) return null;
  return new Response(null, {
    status: 200,
    headers: { 'Content-Type': `application/x-${service}-result`, ...NO_CACHE },
  });
}
