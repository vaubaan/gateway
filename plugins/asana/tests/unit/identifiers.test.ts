/**
 * Hostile identifiers fed to both sides : every gid position of `classify`
 * and of `execute`, the offset, and the resource ref. A refused value sends
 * no request ; an accepted one names exactly the classified object.
 */
import { describe, expect, test } from 'vitest';

import type { Resource } from '@vaubaan/plugin-sdk';
import { mockFetch } from '@vaubaan/plugin-sdk/testing';

import { SERVICE_ID, TOOL } from '../../src/identity.ts';
import { asanaPlugin, classifyAsana } from '../../src/index.ts';
import { PROJECT, SECTION, TASK, ctx, project, world } from './fixtures.ts';

const HOSTILE = [
  '..',
  '.',
  'a/../b',
  '%2e%2e',
  '..%2f',
  '%2f',
  '../',
  '',
  'x\ny',
  '1?x=1#y',
  '1'.repeat(33),
];

/** Each gid position, with the call it sits in. */
const POSITIONS: [string, string, Record<string, unknown>][] = [
  [TOOL.getProject, 'project', { project: PROJECT }],
  [TOOL.listTasks, 'section', { project: PROJECT, section: SECTION }],
  [TOOL.listTasks, 'offset', { project: PROJECT, offset: 'eyJhIjoxfQ' }],
  [TOOL.getTask, 'task_gid', { project: PROJECT, task_gid: TASK }],
  [TOOL.listComments, 'task_gid', { project: PROJECT, task_gid: TASK }],
  [TOOL.createTask, 'parent', { project: PROJECT, name: 'n', parent: TASK }],
  [TOOL.createTask, 'section', { project: PROJECT, name: 'n', section: SECTION }],
  [TOOL.createTask, 'assignee', { project: PROJECT, name: 'n', assignee: 'me' }],
  [TOOL.updateTask, 'task_gid', { project: PROJECT, task_gid: TASK, name: 'n' }],
  [TOOL.updateTask, 'section', { project: PROJECT, task_gid: TASK, section: SECTION }],
  [TOOL.addComment, 'task_gid', { project: PROJECT, task_gid: TASK, text: 't' }],
  [TOOL.deleteTask, 'task_gid', { project: PROJECT, task_gid: TASK }],
];

describe('asana identifiers — what classify refuses, execute does not send', () => {
  test.each(POSITIONS)('%s · %s', async (tool, argument, args) => {
    // An offset is no gid : its overlong value is longer than its own bound.
    const values = argument === 'offset' ? [...HOSTILE.slice(0, -1), 'x'.repeat(1025)] : HOSTILE;
    for (const value of values) {
      const hostile = { ...args, [argument]: value };
      expect('denied' in classifyAsana(tool, hostile, [project]), `${argument}=${value}`).toBe(
        true,
      );
      const fetch = mockFetch([]);
      const result = await asanaPlugin.execute(ctx(fetch), tool, hostile);
      expect(result.isError, `${argument}=${value}`).toBe(true);
      expect(fetch.calls).toHaveLength(0);
    }
  });

  test('an accepted gid is named exactly in the path, and the slice', async () => {
    const out = classifyAsana(TOOL.deleteTask, { project: PROJECT, task_gid: TASK }, [project]);
    expect(JSON.stringify(out)).toContain(TASK);
    const fetch = mockFetch(world());
    await asanaPlugin.execute(ctx(fetch), TOOL.deleteTask, { project: PROJECT, task_gid: TASK });
    for (const call of fetch.calls) {
      expect(new URL(call.url).pathname).toBe(`/api/1.0/tasks/${TASK}`);
    }
  });

  test('a resource ref outside the grammar is refused on both sides, even when it is in the mission', async () => {
    for (const ref of ['..', '%2e%2e', 'a/../b', '../']) {
      const odd: Resource = { service: SERVICE_ID, ref, displayName: 'odd' };
      expect('denied' in classifyAsana(TOOL.getProject, { project: ref }, [odd])).toBe(true);
      expect('denied' in classifyAsana(TOOL.getProject, {}, [odd])).toBe(true);
      const fetch = mockFetch([]);
      const result = await asanaPlugin.execute(ctx(fetch, [odd]), TOOL.getProject, {});
      expect(result.isError).toBe(true);
      expect(fetch.calls).toHaveLength(0);
    }
  });

  test('a workspace gid outside the grammar in the resource metadata is refused before search', async () => {
    const tampered: Resource = { ...project, metadata: { workspace_gid: '../1' } };
    expect('denied' in classifyAsana(TOOL.searchTasks, { text: 'x' }, [tampered])).toBe(true);
    const fetch = mockFetch([]);
    const result = await asanaPlugin.execute(ctx(fetch, [tampered]), TOOL.searchTasks, {
      text: 'x',
    });
    expect(result.isError).toBe(true);
    expect(fetch.calls).toHaveLength(0);
  });
});
