/**
 * Reading an `AppPermission` declaration (`credential.ts`) — the one place
 * the host and a plugin turn it into defaults, a checked choice, the tools a
 * level serves, and whether a granted level covers a needed one.
 *
 * ADR : docs/decisions/company-app-created-from-a-manifest.md.
 *
 * The declaration is the single source of truth : the page that lets the
 * administrator choose the app's permissions, the manifest posted to the
 * provider and the refusal of a tool whose permission the app lacks all read
 * it through these functions, never through a list of their own.
 */

import type { AppPermission } from './credential.ts';

/** The choice "do not request this permission" ; never sent to a provider. */
export const NO_ACCESS = 'none';

/** Permission name → access. Only requested permissions appear. */
export type AppPermissionChoice = Readonly<Record<string, string>>;

/** Rank of `access` among the levels of `permission` (0 = lowest), or -1 when it is not one. */
export function accessRank(permission: AppPermission, access: string | undefined): number {
  if (access === undefined) return -1;
  return permission.levels.findIndex((level) => level.access === access);
}

/** The highest level of a permission : what the plugin's tools need. */
export function highestAccess(permission: AppPermission): string {
  const top = permission.levels[permission.levels.length - 1];
  if (!top) throw new Error(`app permission '${permission.name}' declares no level`);
  return top.access;
}

/** The default choice : every permission at its highest level. */
export function defaultPermissionChoice(
  permissions: readonly AppPermission[],
): AppPermissionChoice {
  const out: Record<string, string> = {};
  for (const permission of permissions) out[permission.name] = highestAccess(permission);
  return out;
}

export type PermissionChoiceResult =
  | { readonly ok: true; readonly permissions: AppPermissionChoice }
  | { readonly ok: false; readonly problems: readonly string[] };

/**
 * Checks a choice against the declaration. `chosen` maps a permission name to
 * one of its levels or `NO_ACCESS`; a permission left out is `NO_ACCESS`. A
 * mandatory permission is kept at its lowest level at least. A name or a level
 * the declaration does not know is refused, never dropped.
 */
export function checkPermissionChoice(
  permissions: readonly AppPermission[],
  chosen: Readonly<Record<string, string>>,
): PermissionChoiceResult {
  const problems: string[] = [];
  const known = new Map(permissions.map((p) => [p.name, p]));
  for (const name of Object.keys(chosen)) {
    if (!known.has(name)) problems.push(`'${name}' is not a permission this app may request`);
  }
  const out: Record<string, string> = {};
  for (const permission of permissions) {
    const access = chosen[permission.name] ?? NO_ACCESS;
    if (access === NO_ACCESS) {
      const lowest = permission.levels[0];
      if (permission.mandatory && lowest) out[permission.name] = lowest.access;
      continue;
    }
    if (accessRank(permission, access) < 0) {
      problems.push(`${permission.label}: '${access}' is not one of its levels`);
      continue;
    }
    out[permission.name] = access;
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true, permissions: out };
}

/**
 * The tools that stop working, entirely or for some calls, when `permission`
 * is requested at `access` (`NO_ACCESS` included): the tools of every level
 * above it. Each tool once, in declaration order.
 */
export function toolsLostAt(permission: AppPermission, access: string): readonly string[] {
  const rank = access === NO_ACCESS ? -1 : accessRank(permission, access);
  const out: string[] = [];
  for (const level of permission.levels.slice(rank + 1)) {
    for (const tool of level.tools) if (!out.includes(tool)) out.push(tool);
  }
  return out;
}

/** True when `granted` is `needed` or a level above it. */
export function accessCovers(
  permission: AppPermission,
  granted: string | undefined,
  needed: string,
): boolean {
  const want = accessRank(permission, needed);
  return want >= 0 && accessRank(permission, granted) >= want;
}

/**
 * What a tool needs on every call : for each permission, the highest level
 * that lists the tool without an `onlyWhen` condition for it. The conditional
 * needs are the plugin's to check, call by call.
 */
export function unconditionalNeeds(
  permissions: readonly AppPermission[],
  tool: string,
): AppPermissionChoice {
  const out: Record<string, string> = {};
  for (const permission of permissions) {
    for (const level of permission.levels) {
      if (level.tools.includes(tool) && level.onlyWhen?.[tool] === undefined) {
        out[permission.name] = level.access;
      }
    }
  }
  return out;
}

/**
 * The needs among `needs` that `granted` (as the provider reported them) does
 * not cover, as `{ permission, access }`, in declaration order.
 */
export function missingPermissions(
  permissions: readonly AppPermission[],
  needs: AppPermissionChoice,
  granted: Readonly<Record<string, string>>,
): ReadonlyArray<{ readonly permission: AppPermission; readonly access: string }> {
  const out: Array<{ permission: AppPermission; access: string }> = [];
  for (const permission of permissions) {
    const needed = needs[permission.name];
    if (needed === undefined) continue;
    if (!accessCovers(permission, granted[permission.name], needed)) {
      out.push({ permission, access: needed });
    }
  }
  return out;
}
