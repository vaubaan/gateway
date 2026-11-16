/**
 * GitHub's REST address and the headers every call carries. Copied from the
 * GitHub plugin's `api.ts` (ADR github-projects-is-its-own-plugin) ; a change
 * to one is made to both.
 */

export const GITHUB_API_BASE = 'https://api.github.com';

/**
 * Headers every call carries. Lower case, as `httpJson` writes its own
 * `accept`. The API version is the one GitHub's Projects reference names
 * (`2026-03-10`) ; the GitHub plugin still sends `2022-11-28`.
 */
export const GITHUB_API_HEADERS = {
  accept: 'application/vnd.github+json',
  'user-agent': 'vaubaan-gateway',
  'x-github-api-version': '2026-03-10',
} as const;

/** The headers of a REST call made with the account's `token`. */
export function githubApiHeaders(token: string): Readonly<Record<string, string>> {
  return { ...GITHUB_API_HEADERS, authorization: `Bearer ${token}` };
}
