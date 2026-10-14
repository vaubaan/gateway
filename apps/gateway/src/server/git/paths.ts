/**
 * The URL grammar of the git remote (spec §4.1 ter): what a path under
 * `/git/` asks for. Pure.
 *
 *   /git/<repository>[.git]/info/refs?service=git-upload-pack|git-receive-pack
 *   /git/<repository>[.git]/git-upload-pack
 *   /git/<repository>[.git]/git-receive-pack
 *   /git/<repository>[.git]/info/lfs/…          Git LFS: answered "not supported"
 *
 * Which repository `<repository>` names is the plugin's call
 * (`GitRemoteCapability.repositoryOf`); this module only cuts the path.
 */
import { RECEIVE_PACK_SERVICE, UPLOAD_PACK_SERVICE } from '@vaubaan/plugin-sdk';

/** The path segment the door lives under (`src/app/git/[...path]/route.ts`). */
export const GIT_DOOR_SEGMENT = '/git/';

/**
 * The base of every repository's remote on this instance (`<public_url>/git/`):
 * the catalog, the setup kit and the mission page derive the URLs from it.
 */
export function gitRemoteBase(publicUrl: URL): string {
  return `${publicUrl.href.replace(/\/+$/, '')}${GIT_DOOR_SEGMENT}`;
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
  /** The repository part of the path, `.git` removed (`acme/app`). */
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

/** Cut a request URL into the repository and the endpoint; `null` outside `/git/`. */
export function parseGitPath(url: URL): GitPath | null {
  const at = url.pathname.indexOf(GIT_DOOR_SEGMENT);
  if (at === -1) return null;
  const rest = url.pathname.slice(at + GIT_DOOR_SEGMENT.length);
  const lfs = rest.indexOf(LFS_SEGMENT);
  if (lfs !== -1) {
    return { repositoryPath: withoutDotGit(rest.slice(0, lfs)), endpoint: { kind: 'lfs' } };
  }
  for (const [suffix, kind] of SUFFIXES) {
    if (!rest.endsWith(suffix)) continue;
    const repositoryPath = withoutDotGit(rest.slice(0, -suffix.length));
    if (kind === 'info-refs') {
      return {
        repositoryPath,
        endpoint: { kind, service: serviceOf(url.searchParams.get('service')) },
      };
    }
    return { repositoryPath, endpoint: { kind } as GitEndpoint };
  }
  return { repositoryPath: withoutDotGit(rest.replace(/\/+$/, '')), endpoint: { kind: 'unknown' } };
}
