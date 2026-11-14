/**
 * Resource discovery of the `asana` provider : one resource per project the
 * account can see, in every workspace it belongs to.
 *
 * Handbook : docs/handbook/providers/asana.md.
 *
 * `GET /users/me` gives the workspaces, then
 * `GET /workspaces/{gid}/projects?archived=false` is read page by page
 * (`next_page.offset`, 100 a page) up to `MAX_PROJECTS` across all
 * workspaces. Every answer goes through a guard, every gid through
 * `asanaGid` ; an answer it does not recognise is Asana's failure
 * (`UpstreamProtocolError`), more projects than the ceiling fail the
 * discovery (a plain `Error`).
 */

import {
  UpstreamProtocolError,
  isList,
  isRecord,
  type AccountContext,
  type Resource,
} from '@vaubaan/plugin-sdk';

import { getObject, isDataList, nextOffsetOf, request, type Json } from './api.ts';
import { asanaGid, offsetToken } from './ids.ts';
import { PROVIDER_ID } from './identity.ts';

/** Most projects one account exposes, all workspaces together. */
export const MAX_PROJECTS = 500;

function unexpected(message: string): never {
  throw new UpstreamProtocolError(`Asana discovery: ${message}`);
}

export interface Workspace {
  readonly gid: string;
  readonly name: string;
}

/** The workspaces of a `GET /users/me` answer, each gid through the grammar. */
export function workspacesOf(me: Json): Workspace[] {
  if (!isList(me.workspaces)) return unexpected('unexpected workspaces in /users/me');
  return me.workspaces.map((w) => {
    const gid = isRecord(w) ? asanaGid(w.gid) : null;
    if (!gid || !isRecord(w)) return unexpected('unexpected workspace in /users/me');
    return { gid, name: typeof w.name === 'string' ? w.name : gid };
  });
}

function projectResource(project: unknown, workspace: Workspace): Resource | null {
  if (!isRecord(project)) return unexpected('unexpected project in the answer');
  const gid = asanaGid(project.gid);
  if (!gid) return unexpected('unexpected project gid in the answer');
  if (project.archived === true) return null;
  const name = typeof project.name === 'string' && project.name !== '' ? project.name : gid;
  const team =
    isRecord(project.team) && typeof project.team.name === 'string' ? project.team.name : null;
  return {
    provider: PROVIDER_ID,
    ref: gid,
    displayName: `${team ?? workspace.name} / ${name}`,
    metadata: {
      workspace_gid: workspace.gid,
      workspace_name: workspace.name,
      ...(team ? { team_name: team } : {}),
    },
  };
}

export async function discoverAsanaResources(ctx: AccountContext): Promise<readonly Resource[]> {
  const me = await getObject(ctx, '/users/me', ['workspaces.name']);
  const found: Resource[] = [];
  for (const workspace of workspacesOf(me)) {
    let offset: string | null = null;
    do {
      const query = new URLSearchParams({
        archived: 'false',
        limit: '100',
        opt_fields: 'name,archived,workspace.name,team.name',
      });
      if (offset) query.set('offset', offset);
      const page = await request(ctx, 'GET', `/workspaces/${workspace.gid}/projects`, isDataList, {
        query,
      });
      for (const project of page.data) {
        const resource = projectResource(project, workspace);
        if (resource) found.push(resource);
      }
      if (found.length > MAX_PROJECTS) {
        throw new Error(
          `${PROVIDER_ID}: this account sees more than ${MAX_PROJECTS} projects; connect an account that sees fewer`,
        );
      }
      const next = nextOffsetOf(page);
      offset =
        next === null ? null : (offsetToken(next) ?? unexpected('unexpected next_page offset'));
    } while (offset);
  }
  return found;
}
