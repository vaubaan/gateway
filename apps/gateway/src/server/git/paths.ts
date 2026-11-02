/**
 * The URL grammar of the git remote (spec §4.1 ter): what a path under
 * `/git/` asks for. Pure.
 *
 *   /git/<provider>/<repository>[.git]/info/refs?service=git-upload-pack|git-receive-pack
 *   /git/<provider>/<repository>[.git]/git-upload-pack
 *   /git/<provider>/<repository>[.git]/git-receive-pack
 *   /git/<provider>/<repository>[.git]/info/lfs/…    Git LFS: answered "not supported"
 *
 * `<provider>` is a plugin id (ADR protocol-doors-belong-to-the-host); which
 * repository `<repository>` names is that plugin's call
 * (`GitRemoteCapability.repositoryOf`); this module only cuts the path.
 */
import { RECEIVE_PACK_SERVICE, UPLOAD_PACK_SERVICE } from '@vaubaan/plugin-sdk/git';

/** The path segment the door lives under (`src/app/git/[...path]/route.ts`). */
export const GIT_DOOR_SEGMENT = '/git/';

/**
 * The base of every remote of one provider on this instance
 * (`<public_url>/git/<provider>/`): the catalog, the setup kit, the mission
 * page and the Reference derive the URLs from it.
 */
export function gitRemoteBase(publicUrl: URL, providerId: string): string {
  return `${publicUrl.href.replace(/\/+$/, '')}${GIT_DOOR_SEGMENT}${providerId}/`;
}

/** The remote URL of one repository: `<public_url>/git/<provider>/<ref>.git`. */
export function gitRemoteUrl(publicUrl: URL, providerId: string, ref: string): string {
  return `${gitRemoteBase(publicUrl, providerId)}${ref}.git`;
}

export const GIT_SERVICES = [UPLOAD_PACK_SERVICE, RECEIVE_PACK_SERVICE] as const;
export type GitService = (typeof GIT_SERVICES)[number];

export type GitEndpoint =
  /** `service` is null for the dumb protocol, which the door does not speak. */
  | { readonly kind: 'info-refs'; readonly service: GitService | null }
  | { readonly kind: 'upload-pack' }
  | { readonly kind: 'receive-pack' }
  | { readonly kind: 'lfs' }
  | { readonly kind: 'unknown' };

export interface GitPath {
  /** The provider segment, a plugin id to resolve (`github`); empty when the path has none. */
  readonly provider: string;
  /** The repository part of the path, provider segment and `.git` removed (`acme/app`). */
  readonly repositoryPath: string;
  readonly endpoint: GitEndpoint;
}

const LFS_SEGMENT = '/info/lfs';
const SUFFIXES: readonly (readonly [string, GitEndpoint['kind']])[] = [
  ['/info/refs', 'info-refs'],
  [`/${UPLOAD_PACK_SERVICE}`, 'upload-pack'],
  [`/${RECEIVE_PACK_SERVICE}`, 'receive-pack'],
];

function serviceOf(value: string | null): GitService | null {
  return GIT_SERVICES.find((s) => s === value) ?? null;
}

function withoutDotGit(path: string): string {
  return path.endsWith('.git') ? path.slice(0, -'.git'.length) : path;
}

/** `<provider>/<rest>` → the provider segment and the rest; no slash → all of it is the provider. */
function splitProvider(path: string): { readonly provider: string; readonly rest: string } {
  const slash = path.indexOf('/');
  return slash === -1
    ? { provider: path, rest: '' }
    : { provider: path.slice(0, slash), rest: path.slice(slash + 1) };
}

/**
 * Cut a request URL into the provider, the repository and the endpoint;
 * `null` outside `/git/`.
 */
export function parseGitPath(url: URL): GitPath | null {
  const at = url.pathname.indexOf(GIT_DOOR_SEGMENT);
  if (at === -1) return null;
  const { provider, rest } = splitProvider(url.pathname.slice(at + GIT_DOOR_SEGMENT.length));
  const lfs = rest.indexOf(LFS_SEGMENT);
  if (lfs !== -1) {
    return {
      provider,
      repositoryPath: withoutDotGit(rest.slice(0, lfs)),
      endpoint: { kind: 'lfs' },
    };
  }
  for (const [suffix, kind] of SUFFIXES) {
    if (!rest.endsWith(suffix)) continue;
    const repositoryPath = withoutDotGit(rest.slice(0, -suffix.length));
    if (kind === 'info-refs') {
      return {
        provider,
        repositoryPath,
        endpoint: { kind, service: serviceOf(url.searchParams.get('service')) },
      };
    }
    return { provider, repositoryPath, endpoint: { kind } as GitEndpoint };
  }
  return {
    provider,
    repositoryPath: withoutDotGit(rest.replace(/\/+$/, '')),
    endpoint: { kind: 'unknown' },
  };
}
