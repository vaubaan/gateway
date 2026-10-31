/**
 * GitHub's addresses and the headers every REST call carries — one source
 * for the credential check, the tools, the job log read and the git remote.
 */

export const GITHUB_API_BASE = 'https://api.github.com';

/** GitHub's web origin : the repositories git clones from and pushes to. */
export const GITHUB_WEB_BASE = 'https://github.com';

/** GitHub's HTTP status for a token that authenticates but may not do this. */
export const HTTP_FORBIDDEN = 403;

/**
 * Headers every call to the GitHub REST API carries. Lower case, as `httpJson`
 * writes its own `accept` : GitHub's media type replaces it instead of being
 * sent next to it.
 */
export const GITHUB_API_HEADERS = {
  accept: 'application/vnd.github+json',
  'user-agent': 'vaubaan-gateway',
  'x-github-api-version': '2022-11-28',
} as const;

/** The headers of a REST call made with the connection's `token`. */
export function githubApiHeaders(token: string): Readonly<Record<string, string>> {
  return { ...GITHUB_API_HEADERS, authorization: `Bearer ${token}` };
}
