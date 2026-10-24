/**
 * `createdResources` of the Railway plugin (ADR created-resources-join-the-mission).
 * Railway does not document what its MCP server's `create-project` answers:
 * the hook reads a project only from a JSON answer naming the project the call
 * asked for, and gives nothing otherwise.
 */
import { describe, expect, test } from 'vitest';

import { createdRailwayResources } from '../../src/created.ts';
import { railwayPlugin } from '../../src/index.ts';

const TOOL = 'railway__create-project';
const ID = '5a8f3a7e-1b2c-4d5e-8f90-123456789abc';
const ENV = '0c1d2e3f-4a5b-4c6d-8e9f-a0b1c2d3e4f5';
const text = (payload: unknown) => ({
  content: [
    {
      type: 'text' as const,
      text: typeof payload === 'string' ? payload : JSON.stringify(payload),
    },
  ],
});

describe('railway createdResources', () => {
  test('a JSON answer naming the project asked for gives it, described as discovery does', () => {
    const created = createdRailwayResources(
      TOOL,
      { name: 'shop' },
      text({
        project: {
          id: ID,
          name: 'shop',
          environments: { edges: [{ node: { id: ENV, name: 'production' } }] },
        },
      }),
    );
    expect(created).toEqual([
      {
        provider: 'railway',
        ref: ID,
        displayName: 'shop',
        metadata: { environments: [{ id: ENV, name: 'production' }], services: [] },
      },
    ]);
    expect(railwayPlugin.createdResources).toBe(createdRailwayResources);
  });

  test('structuredContent and plain lists are read too', () => {
    expect(
      createdRailwayResources(
        TOOL,
        { name: 'shop' },
        {
          content: [],
          structuredContent: { id: ID, name: 'shop', environments: [{ id: ENV, name: 'staging' }] },
        },
      ),
    ).toEqual([
      {
        provider: 'railway',
        ref: ID,
        displayName: 'shop',
        metadata: { environments: [{ id: ENV, name: 'staging' }], services: [] },
      },
    ]);
  });

  test('nothing from a text answer, another name, an id outside the grammar or two projects', () => {
    const args = { name: 'shop' };
    expect(createdRailwayResources(TOOL, args, text(`Created project shop (${ID})`))).toEqual([]);
    expect(createdRailwayResources(TOOL, args, text({ id: ID, name: 'other' }))).toEqual([]);
    expect(createdRailwayResources(TOOL, args, text({ id: '../x', name: 'shop' }))).toEqual([]);
    expect(
      createdRailwayResources(
        TOOL,
        args,
        text([
          { id: ID, name: 'shop' },
          { id: ENV, name: 'shop' },
        ]),
      ),
    ).toEqual([]);
    expect(createdRailwayResources(TOOL, {}, text({ id: ID, name: 'shop' }))).toEqual([]);
    expect(
      createdRailwayResources('railway__list-projects', args, text({ id: ID, name: 'shop' })),
    ).toEqual([]);
  });
});
