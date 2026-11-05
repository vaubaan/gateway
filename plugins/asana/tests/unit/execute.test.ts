/**
 * The executor of the `asana` plugin against `mockFetch` : the requests sent
 * (method, URL, headers, body), the membership proof before every task
 * tool, what is cut out of an answer, the thrown provider failures and the
 * refusals that send nothing.
 */
import { describe, expect, test } from 'vitest';

import type { ExecuteContext } from '@vaubaan/plugin-sdk';
import { mockFetch, refusalText, type MockFetch } from '@vaubaan/plugin-sdk/testing';

import { TOOL } from '../../src/identity.ts';
import { MAX_PARENT_DEPTH, asanaPlugin } from '../../src/index.ts';
import {
  FOREIGN_TASK,
  OTHER_PROJECT,
  OTHER_SECTION,
  PROJECT,
  SECTION,
  SUB_SUBTASK,
  TASK,
  TOKEN,
  USER,
  WORKSPACE,
  ctx,
  isTaskRead,
  otherProject,
  project,
  world,
} from './fixtures.ts';

const exec = (fetch: MockFetch, tool: string, args: Record<string, unknown>, c?: ExecuteContext) =>
  asanaPlugin.execute(c ?? ctx(fetch), tool, args);

const payload = (result: { content: readonly unknown[] }): unknown => {
  const [first] = result.content as { text: string }[];
  return JSON.parse(first!.text);
};

const path = (url: string) => new URL(url).pathname;
const params = (url: string) => Object.fromEntries(new URL(url).searchParams);

describe('executeAsana — reads', () => {
  test('list_projects is answered from the mission, without a request', async () => {
    const fetch = mockFetch([]);
    const result = await exec(fetch, TOOL.listProjects, {}, ctx(fetch, [project, otherProject]));
    expect(payload(result)).toEqual({
      projects: [
        { gid: PROJECT, name: 'Engineering / Roadmap', workspace: 'Acme', team: 'Engineering' },
        { gid: OTHER_PROJECT, name: 'Acme / Hiring', workspace: 'Acme', team: null },
      ],
    });
    expect(fetch.calls).toHaveLength(0);
  });

  test('get_project : the bearer, the accept header, fixed fields', async () => {
    const fetch = mockFetch(world());
    await exec(fetch, TOOL.getProject, { project: PROJECT });
    const [call] = fetch.calls;
    expect(call!.method).toBe('GET');
    expect(path(call!.url)).toBe(`/api/1.0/projects/${PROJECT}`);
    expect(params(call!.url).opt_fields).toContain('owner.name');
    expect(call!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(call!.headers.accept).toBe('application/json');
  });

  test('list_sections follows next_page up to its ceiling', async () => {
    const fetch = mockFetch([
      {
        method: 'GET',
        url: (u) => path(u).endsWith('/sections') && !new URL(u).searchParams.has('offset'),
        body: { data: [{ gid: SECTION, name: 'Doing' }], next_page: { offset: 'eyJhIjoxfQ.x.y' } },
      },
      {
        method: 'GET',
        url: (u) => new URL(u).searchParams.get('offset') === 'eyJhIjoxfQ.x.y',
        body: { data: [{ gid: OTHER_SECTION, name: 'Done' }], next_page: null },
      },
    ]);
    const result = await exec(fetch, TOOL.listSections, { project: PROJECT });
    expect(payload(result)).toEqual({
      sections: [
        { gid: SECTION, name: 'Doing' },
        { gid: OTHER_SECTION, name: 'Done' },
      ],
    });
    expect(params(fetch.calls[0]!.url)).toMatchObject({ limit: '100', opt_fields: 'name' });
  });

  test('list_tasks : the project endpoint, the paging, and the other projects cut out', async () => {
    const fetch = mockFetch([
      {
        method: 'GET',
        url: (u) => path(u) === `/api/1.0/projects/${PROJECT}/tasks`,
        body: {
          data: [
            {
              gid: TASK,
              name: 'Ship v2',
              projects: [{ gid: OTHER_PROJECT }],
              memberships: [
                { project: { gid: PROJECT }, section: { name: 'Doing' } },
                { project: { gid: OTHER_PROJECT }, section: { name: 'Secret column' } },
              ],
            },
          ],
          next_page: { offset: 'eyJ0eXAiOiJKV1QifQ.eyJwIjoyfQ.sig' },
        },
      },
    ]);
    const result = await exec(fetch, TOOL.listTasks, {
      project: PROJECT,
      completed_since: 'now',
      limit: 10,
      offset: 'eyJ0eXAiOiJKV1QifQ.eyJwIjoxfQ.sig',
    });
    expect(payload(result)).toEqual({
      tasks: [{ gid: TASK, name: 'Ship v2', sections: ['Doing'] }],
      next_offset: 'eyJ0eXAiOiJKV1QifQ.eyJwIjoyfQ.sig',
    });
    expect(JSON.stringify(payload(result))).not.toContain('Secret column');
    expect(JSON.stringify(payload(result))).not.toContain(OTHER_PROJECT);
    const q = params(fetch.calls[0]!.url);
    expect(q).toMatchObject({
      completed_since: 'now',
      limit: '10',
      offset: 'eyJ0eXAiOiJKV1QifQ.eyJwIjoxfQ.sig',
    });
    expect(q.opt_fields).not.toMatch(/email/);
  });

  test('list_tasks of a section : the section is proven in the project first', async () => {
    const fetch = mockFetch(world());
    await exec(fetch, TOOL.listTasks, { project: PROJECT, section: SECTION });
    expect(fetch.calls.map((c) => path(c.url))).toEqual([
      `/api/1.0/sections/${SECTION}`,
      `/api/1.0/sections/${SECTION}/tasks`,
    ]);
    const other = mockFetch(world());
    const text = await refusalText(
      exec(other, TOOL.listTasks, { project: PROJECT, section: OTHER_SECTION }),
    );
    expect(text).toBe(`section '${OTHER_SECTION}' is not in project '${PROJECT}'`);
    expect(other.calls).toHaveLength(1);
  });

  test("list_tasks : an offset Asana answers outside the grammar is Asana's failure", async () => {
    const fetch = mockFetch([
      { method: 'GET', url: /\/tasks\?/, body: { data: [], next_page: { offset: 'a/b' } } },
    ]);
    await expect(exec(fetch, TOOL.listTasks, { project: PROJECT })).rejects.toMatchObject({
      name: 'UpstreamProtocolError',
    });
  });

  test('search_tasks : the workspace of the resource, the project as a filter', async () => {
    const fetch = mockFetch(world());
    await exec(fetch, TOOL.searchTasks, {
      project: PROJECT,
      text: 'launch & plan?#',
      completed: false,
      assignee: 'me',
    });
    const [call] = fetch.calls;
    expect(path(call!.url)).toBe(`/api/1.0/workspaces/${WORKSPACE}/tasks/search`);
    expect(params(call!.url)).toMatchObject({
      'projects.any': PROJECT,
      text: 'launch & plan?#',
      completed: 'false',
      'assignee.any': 'me',
      limit: '50',
    });
    expect(call!.url).not.toContain('plan?#');
  });

  test('search_tasks without Premium : the 402 is thrown, typed', async () => {
    const fetch = mockFetch([
      { url: /\/search\?/, status: 402, body: { errors: [{ message: 'premium' }] } },
    ]);
    await expect(
      exec(fetch, TOOL.searchTasks, { project: PROJECT, text: 'x' }),
    ).rejects.toMatchObject({ name: 'UpstreamHttpError', status: 402 });
  });

  test('get_task : one request when the task is in the project, the other projects cut out', async () => {
    const fetch = mockFetch(world());
    const result = await exec(fetch, TOOL.getTask, { project: PROJECT, task_gid: TASK });
    expect(fetch.calls).toHaveLength(1);
    const fields = params(fetch.calls[0]!.url).opt_fields!.split(',');
    expect(fields).toEqual(expect.arrayContaining(['projects.gid', 'parent.gid', 'notes']));
    expect(payload(result)).toEqual({
      gid: TASK,
      name: 'Ship v2',
      parent: null,
      sections: ['Doing'],
    });
  });

  test('get_task of a subtask : proven through its ancestors', async () => {
    const fetch = mockFetch(world());
    const result = await exec(fetch, TOOL.getTask, { project: PROJECT, task_gid: SUB_SUBTASK });
    expect(fetch.calls.map((c) => path(c.url).split('/').at(-1))).toEqual([
      SUB_SUBTASK,
      '1400000000000002',
      TASK,
    ]);
    expect(payload(result)).toMatchObject({ gid: SUB_SUBTASK, name: 'Proofread' });
  });

  test('a task of another project is refused, and nothing about it is returned', async () => {
    const fetch = mockFetch(world());
    for (const tool of [TOOL.getTask, TOOL.listComments, TOOL.deleteTask]) {
      const text = await refusalText(
        exec(fetch, tool, { project: PROJECT, task_gid: FOREIGN_TASK }),
      );
      expect(text).toBe(`task '${FOREIGN_TASK}' is not in project '${PROJECT}'`);
    }
    // One read each, never the write.
    expect(fetch.calls.every(isTaskRead)).toBe(true);
  });

  test(`the walk stops after ${MAX_PARENT_DEPTH} parents`, async () => {
    const chain = (gid: number) => String(1600000000000000 + gid);
    const fetch = mockFetch([
      {
        method: 'GET',
        url: (u) => /\/tasks\/\d+$/.test(path(u)),
        respond: (call) => {
          const gid = Number(path(call.url).split('/').at(-1)) - 1600000000000000;
          return { data: { gid: chain(gid), projects: [], parent: { gid: chain(gid + 1) } } };
        },
      },
    ]);
    const text = await refusalText(
      exec(fetch, TOOL.getTask, { project: PROJECT, task_gid: chain(0) }),
    );
    expect(text).toMatch(/is not in project/);
    expect(fetch.calls).toHaveLength(MAX_PARENT_DEPTH + 1);
  });

  test('a parent Asana answers outside the grammar is its failure', async () => {
    const fetch = mockFetch([
      { method: 'GET', url: /\/tasks\//, body: { data: { projects: [], parent: { gid: '..' } } } },
    ]);
    await expect(
      exec(fetch, TOOL.getTask, { project: PROJECT, task_gid: TASK }),
    ).rejects.toMatchObject({ name: 'UpstreamProtocolError' });
  });

  test('list_comments : comments only, asked of Asana and filtered here', async () => {
    const fetch = mockFetch([
      ...world().slice(0, 1),
      {
        method: 'GET',
        url: /\/stories\?/,
        body: {
          data: [
            { gid: '1', resource_subtype: 'comment_added', text: 'Looks good' },
            { gid: '2', resource_subtype: 'assigned', text: 'assigned to Ana' },
          ],
          next_page: null,
        },
      },
    ]);
    const result = await exec(fetch, TOOL.listComments, { project: PROJECT, task_gid: TASK });
    expect(payload(result)).toEqual({
      comments: [{ gid: '1', resource_subtype: 'comment_added', text: 'Looks good' }],
    });
    expect(params(fetch.calls[1]!.url)).toMatchObject({ resource_subtype: 'comment_added' });
  });
});

describe('executeAsana — writes', () => {
  test('create_task : POST /tasks with the project, field by field', async () => {
    const fetch = mockFetch(world());
    await exec(fetch, TOOL.createTask, {
      project: PROJECT,
      name: 'Draft',
      notes: 'line 1\nline 2',
      assignee: USER,
      due_on: '2026-11-20',
    });
    const [call] = fetch.calls;
    expect(call!.method).toBe('POST');
    expect(path(call!.url)).toBe('/api/1.0/tasks');
    expect(call!.headers['content-type']).toBe('application/json');
    expect(call!.json).toEqual({
      data: {
        name: 'Draft',
        notes: 'line 1\nline 2',
        assignee: USER,
        due_on: '2026-11-20',
        projects: [PROJECT],
      },
    });
  });

  test('create_task in a section : the section proven, then memberships', async () => {
    const fetch = mockFetch(world());
    await exec(fetch, TOOL.createTask, { project: PROJECT, name: 'Draft', section: SECTION });
    expect(fetch.calls.map((c) => `${c.method} ${path(c.url)}`)).toEqual([
      `GET /api/1.0/sections/${SECTION}`,
      'POST /api/1.0/tasks',
    ]);
    expect(fetch.calls[1]!.json).toEqual({
      data: { name: 'Draft', memberships: [{ project: PROJECT, section: SECTION }] },
    });
    const other = mockFetch(world());
    expect(
      await refusalText(
        exec(other, TOOL.createTask, { project: PROJECT, name: 'x', section: OTHER_SECTION }),
      ),
    ).toMatch(/is not in project/);
    expect(other.calls.map((c) => c.method)).toEqual(['GET']);
  });

  test('create_task with a parent : the parent proven, then a subtask without projects', async () => {
    const fetch = mockFetch(world());
    await exec(fetch, TOOL.createTask, { project: PROJECT, name: 'Sub', parent: TASK });
    expect(fetch.calls.map((c) => `${c.method} ${path(c.url)}`)).toEqual([
      `GET /api/1.0/tasks/${TASK}`,
      `POST /api/1.0/tasks/${TASK}/subtasks`,
    ]);
    expect(fetch.calls[1]!.json).toEqual({ data: { name: 'Sub' } });
    const foreign = mockFetch(world());
    expect(
      await refusalText(
        exec(foreign, TOOL.createTask, { project: PROJECT, name: 'Sub', parent: FOREIGN_TASK }),
      ),
    ).toBe(`task '${FOREIGN_TASK}' is not in project '${PROJECT}'`);
    expect(foreign.calls.map((c) => c.method)).toEqual(['GET']);
  });

  test('update_task : proven, the given fields only, then the move', async () => {
    const fetch = mockFetch(world());
    const result = await exec(fetch, TOOL.updateTask, {
      project: PROJECT,
      task_gid: TASK,
      assignee: null,
      due_on: null,
      completed: true,
      section: SECTION,
    });
    expect(fetch.calls.map((c) => `${c.method} ${path(c.url)}`)).toEqual([
      `GET /api/1.0/tasks/${TASK}`,
      `GET /api/1.0/sections/${SECTION}`,
      `PUT /api/1.0/tasks/${TASK}`,
      `POST /api/1.0/sections/${SECTION}/addTask`,
    ]);
    expect(fetch.calls[2]!.json).toEqual({
      data: { assignee: null, due_on: null, completed: true },
    });
    expect(fetch.calls[3]!.json).toEqual({ data: { task: TASK } });
    expect(payload(result)).toMatchObject({ gid: TASK, moved_to_section: SECTION });
  });

  test('update_task with a section only : no PUT', async () => {
    const fetch = mockFetch(world());
    await exec(fetch, TOOL.updateTask, { project: PROJECT, task_gid: TASK, section: SECTION });
    expect(fetch.calls.map((c) => c.method)).toEqual(['GET', 'GET', 'POST']);
  });

  test('update_task to a section of another project : refused before any write', async () => {
    const fetch = mockFetch(world());
    expect(
      await refusalText(
        exec(fetch, TOOL.updateTask, {
          project: PROJECT,
          task_gid: TASK,
          name: 'x',
          section: OTHER_SECTION,
        }),
      ),
    ).toMatch(/section .* is not in project/);
    expect(fetch.calls.map((c) => c.method)).toEqual(['GET', 'GET']);
  });

  test('add_comment : proven, then the text', async () => {
    const fetch = mockFetch(world());
    await exec(fetch, TOOL.addComment, { project: PROJECT, task_gid: TASK, text: 'Done' });
    expect(fetch.calls.map((c) => `${c.method} ${path(c.url)}`)).toEqual([
      `GET /api/1.0/tasks/${TASK}`,
      `POST /api/1.0/tasks/${TASK}/stories`,
    ]);
    expect(fetch.calls[1]!.json).toEqual({ data: { text: 'Done' } });
  });

  test('delete_task : proven, then DELETE, and a confirmation', async () => {
    const fetch = mockFetch(world());
    const result = await exec(fetch, TOOL.deleteTask, { project: PROJECT, task_gid: TASK });
    expect(fetch.calls.map((c) => `${c.method} ${path(c.url)}`)).toEqual([
      `GET /api/1.0/tasks/${TASK}`,
      `DELETE /api/1.0/tasks/${TASK}`,
    ]);
    expect(payload(result)).toMatchObject({ deleted: TASK });
  });

  test('an argument the tool does not declare is never sent', async () => {
    const fetch = mockFetch(world());
    await exec(fetch, TOOL.createTask, {
      project: PROJECT,
      name: 'Draft',
      followers: ['ana@example.org'],
      workspace: '999',
    });
    expect(JSON.stringify(fetch.calls[0]!.json)).not.toMatch(/followers|999/);
  });
});

describe('executeAsana — failures and refusals', () => {
  test('401 and 403 are UpstreamAuthError ; 429 carries its Retry-After', async () => {
    const unauthorized = mockFetch([{ url: /\/projects\//, status: 401, body: { errors: [] } }]);
    await expect(exec(unauthorized, TOOL.getProject, { project: PROJECT })).rejects.toMatchObject({
      name: 'UpstreamAuthError',
      upstreamStatus: 401,
    });
    const forbidden = mockFetch([{ url: /\/tasks\//, status: 403, body: { errors: [] } }]);
    await expect(
      exec(forbidden, TOOL.getTask, { project: PROJECT, task_gid: TASK }),
    ).rejects.toMatchObject({ name: 'UpstreamAuthError', upstreamStatus: 403 });
    const limited = mockFetch([
      { url: /\/projects\//, status: 429, headers: { 'retry-after': '12' }, body: {} },
    ]);
    await expect(exec(limited, TOOL.getProject, { project: PROJECT })).rejects.toMatchObject({
      name: 'UpstreamHttpError',
      status: 429,
    });
    await expect(exec(limited, TOOL.getProject, { project: PROJECT })).rejects.toThrow(
      /retry after 12 s/,
    );
  });

  test('an answer without data is a protocol failure', async () => {
    const fetch = mockFetch([{ url: /\/projects\//, body: { gid: PROJECT } }]);
    await expect(exec(fetch, TOOL.getProject, { project: PROJECT })).rejects.toMatchObject({
      name: 'UpstreamProtocolError',
    });
  });

  test('what classify refuses, execute declines without a request', async () => {
    const fetch = mockFetch([]);
    const cases: [string, Record<string, unknown>][] = [
      [TOOL.getProject, { project: OTHER_PROJECT }],
      [TOOL.getTask, { project: PROJECT, task_gid: '..' }],
      [TOOL.updateTask, { project: PROJECT, task_gid: TASK }],
      [`${TOOL.getTask}_x`, { project: PROJECT }],
    ];
    for (const [tool, args] of cases) {
      expect(await refusalText(exec(fetch, tool, args))).not.toBe('');
    }
    expect(fetch.calls).toHaveLength(0);
  });

  test('a credential without the token field is refused before any request', async () => {
    const fetch = mockFetch([]);
    const noToken: ExecuteContext = {
      ...ctx(fetch),
      credential: { kind: 'api-key', fields: {}, metadata: {} },
    };
    await expect(
      asanaPlugin.execute(noToken, TOOL.getProject, { project: PROJECT }),
    ).rejects.toThrow(/'personal_access_token'/);
    expect(fetch.calls).toHaveLength(0);
  });

  test('no answer carries the token', async () => {
    const fetch = mockFetch(world());
    const result = await exec(fetch, TOOL.getTask, { project: PROJECT, task_gid: TASK });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });
});
