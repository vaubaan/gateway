/**
 * The company's GitHub App, created from the gateway's interface through
 * GitHub's App manifest flow, and the one declaration of the permissions the
 * App may request.
 *
 * ADR  : docs/decisions/company-app-created-from-a-manifest.md.
 * Spec : docs/spec/vaubaan-gateway.md §4.2 Administration (company apps), §6.
 *
 * GitHub's documentation, checked on 2026-10-14 (docs.github.com, "Registering
 * a GitHub App from a manifest" and REST "Create a GitHub App from a
 * manifest"):
 *   - the manifest is posted, as a JSON string in the form field `manifest`,
 *     to `https://github.com/settings/apps/new` (personal account) or
 *     `https://github.com/organizations/<ORG>/settings/apps/new`, with an
 *     optional `state` query parameter;
 *   - the person may edit the name, then confirms; GitHub redirects to the
 *     manifest's `redirect_url` with `code` (and `state`);
 *   - `POST /app-manifests/{code}/conversions`, unauthenticated, answers the
 *     App's `id`, `slug`, `client_id`, `client_secret`, `pem`,
 *     `webhook_secret`, `owner`, `html_url`, `permissions`; the whole flow
 *     must complete within one hour;
 *   - manifest keys used: `name`, `url` (required), `redirect_url`,
 *     `callback_urls` (up to 10), `public`, `default_permissions`,
 *     `request_oauth_on_install`. `hook_attributes` is optional and left out:
 *     the gateway receives no webhook. `setup_url` is left out: with
 *     `request_oauth_on_install` GitHub sends the installing person to the
 *     callback URL instead.
 *
 * The permission list below is what the page offers, what the manifest
 * requests and what `execute` checks a call against (`permission-check.ts`).
 */

import type {
  AppManifestInput,
  AppManifestRegistration,
  AppOwner,
  AppPermission,
  RegisteredApp,
} from '@vaubaan/plugin-sdk';

import { GITHUB_API_BASE, GITHUB_API_HEADERS } from './app-install.ts';
import { GITHUB_APP_CONFIG, GITHUB_WEB_BASE } from './credential-keys.ts';

const WORKFLOW_FILE = 'for a file under .github/workflows/';
const PUSH_TOKEN = 'to hand a push token';
const WORKFLOW_PUSH = 'for a git push that changes a file under .github/workflows/';

/**
 * The permissions of the company's GitHub App, lowest level first, each
 * level with the tools that need it. GitHub's names (`contents`,
 * `pull_requests`…) are the keys of the manifest's `default_permissions` and
 * of the `permissions` of an installation token.
 */
export const GITHUB_APP_PERMISSIONS: readonly AppPermission[] = [
  {
    name: 'metadata',
    label: 'Metadata',
    description: 'Repository names, tags and other basic facts. GitHub gives it to every app.',
    mandatory: true,
    levels: [{ access: 'read', label: 'Read', tools: ['github__list_tags'] }],
  },
  {
    name: 'contents',
    label: 'Contents',
    description: 'The code: branches, files, commits and releases.',
    sensitive:
      'Read and write lets the app change any branch, main included, wherever no branch protection stops it — and private repositories on a free GitHub plan have none.',
    levels: [
      {
        access: 'read',
        label: 'Read',
        tools: [
          'github__list_branches',
          'github__list_commits',
          'github__get_file_contents',
          'github__get_commit',
          'github__search_code',
          'github__list_releases',
          'github__mint_install_token',
          'github__git_fetch',
        ],
      },
      {
        access: 'write',
        label: 'Read and write',
        tools: [
          'github__create_branch',
          'github__create_or_update_file',
          'github__push_files',
          'github__delete_file',
          'github__merge_pull_request',
          'github__create_release',
          'github__delete_release',
          'github__mint_install_token',
          'github__git_push',
        ],
        onlyWhen: { github__mint_install_token: PUSH_TOKEN },
      },
    ],
  },
  {
    name: 'pull_requests',
    label: 'Pull requests',
    description: 'Reading, opening and merging pull requests.',
    levels: [
      {
        access: 'read',
        label: 'Read',
        tools: [
          'github__list_pull_requests',
          'github__get_pull_request',
          'github__merge_pull_request',
        ],
      },
      {
        access: 'write',
        label: 'Read and write',
        tools: [
          'github__create_pull_request',
          'github__merge_pull_request',
          'github__mint_install_token',
        ],
        onlyWhen: { github__mint_install_token: PUSH_TOKEN },
      },
    ],
  },
  {
    name: 'issues',
    label: 'Issues',
    description: 'Reading issues and commenting on issues and pull requests.',
    levels: [
      {
        access: 'read',
        label: 'Read',
        tools: ['github__list_issues', 'github__get_issue', 'github__search_issues'],
      },
      { access: 'write', label: 'Read and write', tools: ['github__add_issue_comment'] },
    ],
  },
  {
    name: 'actions',
    label: 'Actions',
    description: 'Reading the workflows of a repository and their runs.',
    levels: [
      {
        access: 'read',
        label: 'Read',
        tools: ['github__list_workflows', 'github__list_workflow_runs'],
      },
    ],
  },
  {
    name: 'administration',
    label: 'Administration',
    description: 'Branch protection and the other settings of a repository.',
    sensitive:
      'Read and write lets the app change branch protection — it could remove the very rule that keeps main safe. No preset gives the tool that uses it.',
    levels: [
      { access: 'read', label: 'Read', tools: ['github__get_branch_protection'] },
      { access: 'write', label: 'Read and write', tools: ['github__update_branch_protection'] },
    ],
  },
  {
    name: 'workflows',
    label: 'Workflows',
    description: 'Changing the files under .github/workflows/.',
    sensitive:
      'A workflow runs with the repository’s secrets: writing one is a way to reach them. Without it, a write under .github/workflows/ is refused.',
    levels: [
      {
        access: 'write',
        label: 'Read and write',
        tools: [
          'github__create_or_update_file',
          'github__push_files',
          'github__delete_file',
          'github__mint_install_token',
          'github__git_push',
        ],
        onlyWhen: {
          github__create_or_update_file: WORKFLOW_FILE,
          github__push_files: WORKFLOW_FILE,
          github__delete_file: WORKFLOW_FILE,
          github__git_push: WORKFLOW_PUSH,
          github__mint_install_token: `${PUSH_TOKEN} that may change workflows`,
        },
      },
    ],
  },
];

/** A GitHub login: letters, digits and single hyphens, 39 characters at most. */
export const GITHUB_LOGIN_PATTERN = '^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$';
/** GitHub refuses an App name longer than this. */
export const GITHUB_APP_NAME_MAX_LENGTH = 34;
/** A manifest code as GitHub issues it; anything else never reaches a URL path. */
const MANIFEST_CODE = /^[A-Za-z0-9_-]{1,128}$/;
const APP_SLUG = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const PEM = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;

function registrationUrl(owner: AppOwner): string {
  if (owner.kind === 'personal') return `${GITHUB_WEB_BASE}/settings/apps/new`;
  if (!new RegExp(GITHUB_LOGIN_PATTERN).test(owner.login)) {
    throw new Error(`github: '${owner.login.slice(0, 60)}' is not an organisation login`);
  }
  return `${GITHUB_WEB_BASE}/organizations/${owner.login}/settings/apps/new`;
}

/**
 * The manifest posted to GitHub. Private (`public: false`): only the owner
 * account can install it. The person who installs it is asked to authorize
 * the App, so the callback carries the code `userVerification` needs.
 */
export function buildGithubManifest(input: AppManifestInput): Readonly<Record<string, unknown>> {
  return {
    name: input.name,
    url: input.homepageUrl,
    description:
      'The GitHub App of a self-hosted Vaubaan Gateway: missions of coding agents reach the repositories it is installed on, within the limits their creators set.',
    redirect_url: input.redirectUrl,
    callback_urls: [input.callbackUrl],
    request_oauth_on_install: true,
    public: false,
    default_permissions: { ...input.permissions },
  };
}

function conversionUrl(code: string): string | null {
  if (!MANIFEST_CODE.test(code)) return null;
  return `${GITHUB_API_BASE}/app-manifests/${code}/conversions`;
}

function stringOf(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The App GitHub created, from the answer of the conversion; `null` when a field is missing. */
export function githubRegisteredApp(body: unknown): RegisteredApp | null {
  if (!isRecord(body)) return null;
  const id = body.id;
  const appId =
    typeof id === 'number' && Number.isInteger(id) && id > 0
      ? String(id)
      : typeof id === 'string' && /^[0-9]+$/.test(id)
        ? id
        : null;
  const slug = stringOf(body.slug);
  const clientId = stringOf(body.client_id);
  const clientSecret = stringOf(body.client_secret);
  const pem = stringOf(body.pem);
  const name = stringOf(body.name);
  const htmlUrl = stringOf(body.html_url);
  const ownerLogin = isRecord(body.owner) ? stringOf(body.owner.login) : null;
  if (!appId || !slug || !clientId || !clientSecret || !pem || !name || !htmlUrl || !ownerLogin) {
    return null;
  }
  if (!APP_SLUG.test(slug) || !PEM.test(pem) || !htmlUrl.startsWith(`${GITHUB_WEB_BASE}/`)) {
    return null;
  }
  const permissions: Record<string, string> = {};
  if (isRecord(body.permissions)) {
    for (const [key, value] of Object.entries(body.permissions)) {
      if (typeof value === 'string') permissions[key] = value;
    }
  }
  return {
    appConfig: {
      [GITHUB_APP_CONFIG.appId]: appId,
      [GITHUB_APP_CONFIG.privateKey]: pem,
      [GITHUB_APP_CONFIG.appSlug]: slug,
      [GITHUB_APP_CONFIG.clientId]: clientId,
      [GITHUB_APP_CONFIG.clientSecret]: clientSecret,
    },
    name,
    slug,
    ownerLogin,
    htmlUrl,
    permissions,
  };
}

export const githubManifestRegistration: AppManifestRegistration = {
  permissions: GITHUB_APP_PERMISSIONS,
  ownerLoginPattern: GITHUB_LOGIN_PATTERN,
  nameMaxLength: GITHUB_APP_NAME_MAX_LENGTH,
  registrationUrl,
  manifestField: 'manifest',
  stateParam: 'state',
  codeParam: 'code',
  buildManifest: buildGithubManifest,
  conversionUrl,
  conversionHeaders: GITHUB_API_HEADERS,
  registeredApp: githubRegisteredApp,
};
