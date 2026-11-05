/**
 * The classifier of the `asana` plugin, branch by branch : the slices of
 * every tool, and every refusal (unknown tool, project outside the mission,
 * ambiguous or missing project, malformed identifier or value).
 */
import { describe, expect, test } from 'vitest';

import { serializeSlice, toolPrefixFor, type Resource } from '@vaubaan/plugin-sdk';

import { PROVIDER_ID, TOOL } from '../../src/identity.ts';
import { classifyAsana } from '../../src/index.ts';
import {
  BARE_PROJECT,
  OTHER_PROJECT,
  PROJECT,
  SECTION,
  TASK,
  USER,
  bareProject,
  otherProject,
  project,
} from './fixtures.ts';

const slices = (
  tool: string,
  args: Record<string, unknown>,
  resources: readonly Resource[] = [project],
) => {
  const out = classifyAsana(tool, args, resources);
  if ('denied' in out) throw new Error(out.denied);
  return out.slices.map(serializeSlice);
};

const denied = (
  tool: string,
  args: Record<string, unknown>,
  resources: readonly Resource[] = [project],
) => {
  const out = classifyAsana(tool, args, resources);
  return 'denied' in out ? out.denied : null;
};

const P = `${PROVIDER_ID}.project[${PROJECT}]`;

describe('classifyAsana — slices', () => {
  test('list_projects names every project of the mission, in one bounded slice', () => {
    expect(slices(TOOL.listProjects, {}, [project, otherProject])).toEqual([
      `${PROVIDER_ID}.project[${PROJECT},${OTHER_PROJECT}].R`,
    ]);
    expect(slices(TOOL.listProjects, {})).toEqual([`${P}.R`]);
  });

  test('project reads', () => {
    expect(slices(TOOL.getProject, { project: PROJECT })).toEqual([`${P}.R`]);
    expect(slices(TOOL.listSections, { project: PROJECT })).toEqual([`${P}.section[*].R`]);
  });

  test('task lists and search read every task of the project', () => {
    expect(slices(TOOL.listTasks, { project: PROJECT })).toEqual([`${P}.task[*].R`]);
    expect(
      slices(TOOL.listTasks, {
        project: PROJECT,
        section: SECTION,
        completed_since: '2026-11-01T00:00:00Z',
        limit: 100,
        offset: 'eyJ0eXAiOiJKV1QifQ.eyJwIjoxfQ.c2ln',
      }),
    ).toEqual([`${P}.task[*].R`]);
    expect(slices(TOOL.searchTasks, { project: PROJECT, text: 'x', assignee: USER })).toEqual([
      `${P}.task[*].R`,
    ]);
  });

  test('one task, its comments', () => {
    expect(slices(TOOL.getTask, { project: PROJECT, task_gid: TASK })).toEqual([
      `${P}.task[${TASK}].R`,
    ]);
    expect(slices(TOOL.listComments, { project: PROJECT, task_gid: TASK })).toEqual([
      `${P}.task[${TASK}].comment[*].R`,
    ]);
  });

  test('writes : create on the collection, change, comment, and the layered deletion', () => {
    expect(slices(TOOL.createTask, { project: PROJECT, name: 'n' })).toEqual([`${P}.task.W`]);
    expect(slices(TOOL.createTask, { project: PROJECT, name: 'n', parent: TASK })).toEqual([
      `${P}.task.W`,
    ]);
    expect(slices(TOOL.updateTask, { project: PROJECT, task_gid: TASK, assignee: null })).toEqual([
      `${P}.task[${TASK}].W`,
    ]);
    expect(slices(TOOL.addComment, { project: PROJECT, task_gid: TASK, text: 'ok' })).toEqual([
      `${P}.task[${TASK}].comment.W`,
    ]);
    expect(slices(TOOL.deleteTask, { project: PROJECT, task_gid: TASK })).toEqual([
      `${P}.task[${TASK}].W`,
      `${P}.task[${TASK}].delete.W`,
    ]);
  });

  test('project defaults to the single mission project', () => {
    expect(slices(TOOL.getTask, { task_gid: TASK })).toEqual([`${P}.task[${TASK}].R`]);
  });
});

describe('classifyAsana — refusals', () => {
  test('an unknown tool', () => {
    const unknown = `${toolPrefixFor(PROVIDER_ID)}delete_project`;
    expect(denied(unknown, { project: PROJECT })).toBe(`unknown tool '${unknown}'`);
  });

  test('a project outside the mission, of another provider, missing or ambiguous', () => {
    expect(denied(TOOL.getProject, { project: OTHER_PROJECT })).toBe(
      `project '${OTHER_PROJECT}' is not selected in this mission`,
    );
    const foreign: Resource = { provider: 'other', ref: OTHER_PROJECT, displayName: 'x' };
    expect(denied(TOOL.getProject, { project: OTHER_PROJECT }, [project, foreign])).toMatch(
      /not selected in this mission/,
    );
    expect(denied(TOOL.getProject, {}, [project, otherProject])).toBe(
      'project: argument missing and the mission selects 2 Asana projects — name one',
    );
    expect(denied(TOOL.getProject, {}, [])).toMatch(/selects no Asana project/);
    expect(denied(TOOL.listProjects, {}, [])).toBe('the mission selects no Asana project');
  });

  test('a malformed project, task, section, parent or assignee gid', () => {
    for (const hostile of ['..', 'a/b', '%2f', '12 3', '', '1'.repeat(33), 12, null]) {
      expect(denied(TOOL.getProject, { project: hostile })).toMatch(
        /^project: missing or malformed/,
      );
      expect(denied(TOOL.getTask, { project: PROJECT, task_gid: hostile })).toMatch(
        /^task_gid: missing or malformed/,
      );
      expect(denied(TOOL.listTasks, { project: PROJECT, section: hostile })).toMatch(/^section:/);
      expect(denied(TOOL.createTask, { project: PROJECT, name: 'n', parent: hostile })).toMatch(
        /^parent:/,
      );
      expect(denied(TOOL.createTask, { project: PROJECT, name: 'n', assignee: hostile })).toMatch(
        /^assignee:/,
      );
    }
    // An email address is never an assignee : the classifier parses no address.
    expect(
      denied(TOOL.createTask, { project: PROJECT, name: 'n', assignee: 'ana@example.org' }),
    ).toMatch(/^assignee:/);
    expect(denied(TOOL.getTask, { project: PROJECT })).toMatch(/^task_gid:/);
  });

  test('a mission resource whose ref is not a gid is unusable', () => {
    const odd: Resource = { provider: PROVIDER_ID, ref: 'not-a-gid', displayName: 'x' };
    expect(denied(TOOL.getProject, {}, [odd])).toBe(
      'project: the mission resource is not an Asana gid',
    );
    expect(denied(TOOL.listProjects, {}, [odd])).toBe('the mission selects no Asana project');
  });

  test('list_tasks : completed_since, limit and offset have their grammars', () => {
    for (const bad of ['yesterday', '2026-11-01', '2026-11-01T00:00:00', 5]) {
      expect(denied(TOOL.listTasks, { project: PROJECT, completed_since: bad })).toMatch(
        /^completed_since:/,
      );
    }
    expect(denied(TOOL.listTasks, { project: PROJECT, completed_since: 'now' })).toBeNull();
    for (const bad of [0, 101, 2.5, '10']) {
      expect(denied(TOOL.listTasks, { project: PROJECT, limit: bad })).toMatch(/^limit:/);
    }
    for (const bad of ['..', '.', 'a/b', 'a b', 'x?y', '', 'x'.repeat(1025), 3]) {
      expect(denied(TOOL.listTasks, { project: PROJECT, offset: bad })).toMatch(/^offset:/);
    }
  });

  test('search_tasks : text bounded on one line, completed a boolean, a workspace known', () => {
    expect(denied(TOOL.searchTasks, { project: PROJECT })).toMatch(/^text:/);
    expect(denied(TOOL.searchTasks, { project: PROJECT, text: 'a\nb' })).toMatch(/^text:/);
    expect(denied(TOOL.searchTasks, { project: PROJECT, text: 'x'.repeat(501) })).toMatch(/^text:/);
    expect(denied(TOOL.searchTasks, { project: PROJECT, text: 'x', completed: 'yes' })).toMatch(
      /^completed:/,
    );
    expect(denied(TOOL.searchTasks, { project: BARE_PROJECT, text: 'x' }, [bareProject])).toBe(
      `project '${BARE_PROJECT}': its workspace is unknown; refresh the account`,
    );
  });

  test('create_task : a name, a date, never section and parent together', () => {
    expect(denied(TOOL.createTask, { project: PROJECT })).toMatch(/^name:/);
    expect(denied(TOOL.createTask, { project: PROJECT, name: 'a\nb' })).toMatch(/^name:/);
    expect(denied(TOOL.createTask, { project: PROJECT, name: 'n', due_on: '20/11/2026' })).toMatch(
      /^due_on:/,
    );
    expect(denied(TOOL.createTask, { project: PROJECT, name: 'n', notes: 'a\u0000b' })).toMatch(
      /^notes:/,
    );
    expect(
      denied(TOOL.createTask, { project: PROJECT, name: 'n', section: SECTION, parent: TASK }),
    ).toMatch(/^section and parent/);
  });

  test('update_task : at least one change, each in its grammar ; null clears', () => {
    expect(denied(TOOL.updateTask, { project: PROJECT, task_gid: TASK })).toMatch(
      /^nothing to change/,
    );
    expect(denied(TOOL.updateTask, { project: PROJECT, task_gid: TASK, completed: 1 })).toMatch(
      /^completed:/,
    );
    expect(denied(TOOL.updateTask, { project: PROJECT, task_gid: TASK, due_on: 'soon' })).toMatch(
      /^due_on:/,
    );
    expect(denied(TOOL.updateTask, { project: PROJECT, task_gid: TASK, assignee: 'x' })).toMatch(
      /^assignee:/,
    );
    expect(denied(TOOL.updateTask, { project: PROJECT, task_gid: TASK, name: '' })).toMatch(
      /^name:/,
    );
    for (const change of [
      { due_on: null },
      { assignee: null },
      { notes: '' },
      { section: SECTION },
    ]) {
      expect(denied(TOOL.updateTask, { project: PROJECT, task_gid: TASK, ...change })).toBeNull();
    }
  });

  test('add_comment : a text', () => {
    expect(denied(TOOL.addComment, { project: PROJECT, task_gid: TASK })).toMatch(/^text:/);
    expect(denied(TOOL.addComment, { project: PROJECT, task_gid: TASK, text: '' })).toMatch(
      /^text:/,
    );
    expect(
      denied(TOOL.addComment, { project: PROJECT, task_gid: TASK, text: 'line one\nline two' }),
    ).toBeNull();
  });
});
