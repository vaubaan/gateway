/**
 * The Asana world the tests run against : one workspace, two projects, a
 * task tree, and the routes that answer them through `mockFetch`.
 */
import type { ExecuteContext, Resource } from '@vaubaan/plugin-sdk';
import type { MockRoute, RecordedCall } from '@vaubaan/plugin-sdk/testing';

import { ASANA_API_BASE } from '../../src/api.ts';
import { PAT_FIELD, PROVIDER_ID } from '../../src/identity.ts';

export const TOKEN = '2/1200000000000000/1200000000000999:0123456789abcdef';
export const WORKSPACE = '1100000000000001';
export const PROJECT = '1200000000000001';
export const OTHER_PROJECT = '1200000000000002';
/** A project of the mission whose resource carries no workspace. */
export const BARE_PROJECT = '1200000000000003';
export const SECTION = '1300000000000001';
export const OTHER_SECTION = '1300000000000002';
export const TASK = '1400000000000001';
/** A subtask of `TASK`, two levels down : in the project through its ancestors. */
export const SUBTASK = '1400000000000002';
export const SUB_SUBTASK = '1400000000000003';
/** A task of another project only. */
export const FOREIGN_TASK = '1400000000000009';
export const USER = '1500000000000001';
/** The parent of a subtask in the samples : distinct from `TASK`, so the proof sees it in the path. */
export const PARENT_SAMPLE = '1400000000000005';

export const project: Resource = {
  provider: PROVIDER_ID,
  ref: PROJECT,
  displayName: 'Engineering / Roadmap',
  metadata: { workspace_gid: WORKSPACE, workspace_name: 'Acme', team_name: 'Engineering' },
};
export const otherProject: Resource = {
  provider: PROVIDER_ID,
  ref: OTHER_PROJECT,
  displayName: 'Acme / Hiring',
  metadata: { workspace_gid: WORKSPACE, workspace_name: 'Acme' },
};
export const bareProject: Resource = {
  provider: PROVIDER_ID,
  ref: BARE_PROJECT,
  displayName: 'Acme / Old',
};

export const api = (path: string) => `${ASANA_API_BASE}${path}`;

export function ctx(
  fetch: typeof globalThis.fetch,
  resources: readonly Resource[] = [project],
): ExecuteContext {
  return {
    credential: { kind: 'api-key', fields: { [PAT_FIELD]: TOKEN }, metadata: {} },
    fetch,
    resources,
  };
}

const ref = (gid: string) => ({ gid });

/** The tasks of the world : gid → record (as `GET /tasks/{gid}` answers it). */
export const TASKS: Readonly<Record<string, Record<string, unknown>>> = {
  [TASK]: {
    gid: TASK,
    name: 'Ship v2',
    projects: [ref(PROJECT), ref(OTHER_PROJECT)],
    memberships: [
      { project: ref(PROJECT), section: { gid: SECTION, name: 'Doing' } },
      { project: ref(OTHER_PROJECT), section: { gid: OTHER_SECTION, name: 'Secret column' } },
    ],
    parent: null,
  },
  [SUBTASK]: {
    gid: SUBTASK,
    name: 'Write notes',
    projects: [],
    memberships: [],
    parent: ref(TASK),
  },
  [SUB_SUBTASK]: {
    gid: SUB_SUBTASK,
    name: 'Proofread',
    projects: [],
    memberships: [],
    parent: ref(SUBTASK),
  },
  [FOREIGN_TASK]: {
    gid: FOREIGN_TASK,
    name: 'Elsewhere',
    projects: [ref(OTHER_PROJECT)],
    memberships: [{ project: ref(OTHER_PROJECT) }],
    parent: null,
  },
};

const gidAfter = (url: string, segment: string): string =>
  new URL(url).pathname.split('/').at(new URL(url).pathname.split('/').indexOf(segment) + 1) ?? '';

/** `GET /tasks/{gid}` (and nothing below it). */
export const isTaskRead = (call: { method: string; url: string }) =>
  call.method === 'GET' && /\/tasks\/\d+$/.test(new URL(call.url).pathname);

/** The routes of the world : tasks and sections by gid, lists empty, writes echoed. */
export function world(): MockRoute[] {
  return [
    {
      method: 'GET',
      url: (url: string) => /\/tasks\/\d+$/.test(new URL(url).pathname),
      respond: (call: RecordedCall) => {
        const gid = gidAfter(call.url, 'tasks');
        return { data: TASKS[gid] ?? { gid, projects: [ref(PROJECT)], parent: null } };
      },
    },
    {
      method: 'GET',
      url: (url: string) => /\/sections\/\d+$/.test(new URL(url).pathname),
      respond: (call: RecordedCall) => {
        const gid = gidAfter(call.url, 'sections');
        return { data: { gid, project: ref(gid === OTHER_SECTION ? OTHER_PROJECT : PROJECT) } };
      },
    },
    {
      method: 'GET',
      url: (url: string) => /\/(tasks|sections|stories|search)$/.test(new URL(url).pathname),
      body: { data: [], next_page: null },
    },
    {
      method: 'GET',
      url: (url: string) => /\/projects\/\d+$/.test(new URL(url).pathname),
      body: { data: { gid: PROJECT, name: 'Roadmap' } },
    },
    {
      method: 'POST',
      url: () => true,
      respond: (call: RecordedCall) => ({
        data: { gid: '1400000000000077', ...(isRecordLike(call.json) ? call.json.data : {}) },
      }),
    },
    {
      method: 'PUT',
      url: () => true,
      respond: (call) => ({ data: { gid: TASK, ...dataOf(call) } }),
    },
    { method: 'DELETE', url: () => true, body: { data: {} } },
  ];
}

function isRecordLike(x: unknown): x is { data: Record<string, unknown> } {
  return typeof x === 'object' && x !== null && 'data' in x;
}

function dataOf(call: RecordedCall): Record<string, unknown> {
  return isRecordLike(call.json) ? call.json.data : {};
}
