/**
 * GitHub's addresses and the headers every REST call carries — one source
 * for the credential check, the tools, the job log read and the git remote.
 */

export const GITHUB_API_BASE = 'https://api.github.com';

/** GitHub's web origin : the repositories git clones from and pushes to. */
export const GITHUB_WEB_BASE = 'https://github.com';

/** Headers every call to the GitHub REST API carries. */
export const GITHUB_API_HEADERS = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'vaubaan-gateway',
  'X-GitHub-Api-Version': '2022-11-28',
} as const;
