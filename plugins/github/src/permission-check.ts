/**
 * A call the company's GitHub App has no permission for is declined, by
 * name, before it is sent — not left to come back as GitHub's bare 403.
 *
 * ADR : docs/decisions/company-app-created-from-a-manifest.md.
 *
 * The administrator chooses, when creating the App, which permissions it
 * requests (`GITHUB_APP_PERMISSIONS`, `app-manifest.ts`), and an installation
 * may hold fewer than the App asks. An installation token reports what it
 * holds (`permissions` of `POST /app/installations/{id}/access_tokens`); the
 * needs of a call come from the same declaration, plus the needs that depend
 * on the arguments (a file under `.github/workflows/`).
 */

import { ExecutorRefusal, missingPermissions, unconditionalNeeds } from '@vaubaan/plugin-sdk';

import { GITHUB_APP_PERMISSIONS } from './app-manifest.ts';
import { MINT_TOOL, type GithubCall } from './call.ts';

/** GitHub asks for `workflows` on any change under this directory. */
const WORKFLOW_DIRECTORY = /^\.github\/workflows\//i;

/** Permission sets of `github__mint_install_token`, by purpose: what it needs, what it adds when held. */
export const MINT_NEEDS = {
  clone: { needs: { contents: 'read' }, whenHeld: {} },
  push: {
    needs: { contents: 'write' },
    // A push that opens a pull request or touches a workflow needs these as
    // well; they go on the token only when the installation holds them.
    whenHeld: { pull_requests: 'write', workflows: 'write' },
  },
} as const satisfies Record<
  'clone' | 'push',
  { needs: Record<string, string>; whenHeld: Record<string, string> }
>;

function touchesWorkflows(call: GithubCall): boolean {
  switch (call.tool) {
    case 'github__create_or_update_file':
    case 'github__delete_file':
      return WORKFLOW_DIRECTORY.test(call.path);
    case 'github__push_files':
      return call.files.some((file) => WORKFLOW_DIRECTORY.test(file.path));
    default:
      return false;
  }
}

/** What a call needs, permission name → access. */
export function needsOf(call: GithubCall): Record<string, string> {
  if (call.tool === MINT_TOOL) return { ...MINT_NEEDS[call.purpose].needs };
  const needs: Record<string, string> = {
    ...unconditionalNeeds(GITHUB_APP_PERMISSIONS, call.tool),
  };
  if (touchesWorkflows(call)) needs.workflows = 'write';
  return needs;
}

/**
 * Declines the call when the installation token's permissions do not cover
 * its needs. An empty `granted` means GitHub did not say (an older cached
 * token): nothing is declined on a guess.
 */
export function assertAppPermissions(
  call: GithubCall,
  granted: Readonly<Record<string, string>>,
): void {
  if (Object.keys(granted).length === 0) return;
  const missing = missingPermissions(GITHUB_APP_PERMISSIONS, needsOf(call), granted);
  if (missing.length === 0) return;
  const plural = missing.length > 1 ? 'permissions' : 'permission';
  throw new ExecutorRefusal(
    `${call.tool} needs the GitHub App ${plural} ${namesOf(missing)}, which this installation of the company's App does not hold; nothing was sent. ${HOW_TO_ADD}`,
  );
}

/**
 * Declines a mint GitHub refused (422) even with the permissions its purpose
 * cannot do without: the installation lacks at least one of `needs`.
 */
export function declineMissingPermissions(
  call: GithubCall,
  needs: Readonly<Record<string, string>>,
): never {
  const named = namesOf(missingPermissions(GITHUB_APP_PERMISSIONS, needs, {}));
  throw new ExecutorRefusal(
    `${call.tool} needs the GitHub App permissions ${named}; GitHub refused a token with them, so this installation of the company's App lacks at least one. ${HOW_TO_ADD}`,
  );
}

const HOW_TO_ADD =
  'An administrator can add it to the App on GitHub; the organisation then accepts the new permission.';

function namesOf(missing: ReturnType<typeof missingPermissions>): string {
  return missing
    .map(({ permission, access }) => {
      const level = permission.levels.find((l) => l.access === access);
      return `${permission.label} (${permission.name}: ${access}${level ? `, “${level.label}”` : ''})`;
    })
    .join(', ');
}

/** The permissions to put on a minted token: the needs, plus what the installation holds of `whenHeld`. */
export function mintPermissions(
  purpose: 'clone' | 'push',
  granted: Readonly<Record<string, string>>,
): Record<string, string> {
  const { needs, whenHeld } = MINT_NEEDS[purpose];
  const out: Record<string, string> = { ...needs };
  const unknown = Object.keys(granted).length === 0;
  for (const [name, access] of Object.entries(whenHeld)) {
    if (unknown || granted[name] === access) out[name] = access;
  }
  // GitHub requires metadata on every token; it is always granted.
  out.metadata = 'read';
  return out;
}
