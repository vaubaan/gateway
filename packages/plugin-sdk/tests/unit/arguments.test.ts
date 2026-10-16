import { describe, expect, test } from 'vitest';

import type { McpToolDeclaration } from '@vaubaan/shared';

import { declaredArgumentsOf, undeclaredArgumentDenial } from '../../src/arguments.ts';
import { declaredOnly } from '../../src/testing/index.ts';

const tools: readonly McpToolDeclaration[] = [
  {
    name: 'acme__get_widget',
    description: 'Read a widget.',
    inputSchema: {
      type: 'object',
      properties: { workspace: { type: 'string' }, id: { type: 'string' } },
      required: ['id'],
    },
  },
  // An open upstream schema: no property at all.
  { name: 'acme__whoami', description: 'Who am I.', inputSchema: { type: 'object' } },
];
const declared = declaredArgumentsOf(tools);
const denial = (tool: string, args: Record<string, unknown>, routing?: ReadonlySet<string>) =>
  undeclaredArgumentDenial(declared, tool, args, routing);

describe('undeclaredArgumentDenial — the argument surface of a tool is closed', () => {
  test('every declared argument passes, in any number', () => {
    expect(denial('acme__get_widget', {})).toBeNull();
    expect(denial('acme__get_widget', { id: 'w1' })).toBeNull();
    expect(denial('acme__get_widget', { id: 'w1', workspace: 'ws' })).toBeNull();
  });

  test('an argument the schema does not declare is refused, naming it and the tool', () => {
    expect(denial('acme__get_widget', { id: 'w1', verify_jwt: false })).toBe(
      "verify_jwt: not an argument of 'acme__get_widget' — nothing classifies it, so it is not sent.",
    );
    // The first one, in the order of the call.
    expect(denial('acme__get_widget', { b: 1, id: 'w1', a: 2 })).toMatch(/^b: /);
  });

  test('a tool that declares nothing takes nothing', () => {
    expect(denial('acme__whoami', {})).toBeNull();
    expect(denial('acme__whoami', { limit: 5 })).toMatch(
      /^limit: not an argument of 'acme__whoami'/,
    );
  });

  test('`undefined` is an absent argument ; null, false, 0 and "" are values', () => {
    expect(denial('acme__get_widget', { extra: undefined })).toBeNull();
    for (const value of [null, false, 0, '']) {
      expect(denial('acme__get_widget', { extra: value }), String(value)).not.toBeNull();
    }
  });

  test('another spelling of a declared argument is another argument', () => {
    for (const key of ['ID', 'Id', 'id ', ' id', 'workspace_id', 'workspaceId']) {
      expect(denial('acme__get_widget', { [key]: 'w1' }), key).not.toBeNull();
    }
  });

  test('inherited names are not declared arguments', () => {
    for (const key of ['constructor', 'toString', 'hasOwnProperty']) {
      expect(denial('acme__get_widget', { [key]: 'x' }), key).not.toBeNull();
    }
    // `__proto__` as an own key, the way a JSON body carries it.
    const args = JSON.parse('{"__proto__": {"id": "w1"}}') as Record<string, unknown>;
    expect(denial('acme__get_widget', args)).not.toBeNull();
  });

  test('a key that is not name-shaped is described, never quoted', () => {
    const hostile = 'x\n\u001b[31m] not an argument of';
    expect(denial('acme__get_widget', { [hostile]: 1 })).toBe(
      "an argument with a malformed name: not an argument of 'acme__get_widget' — nothing classifies it, so it is not sent.",
    );
    expect(denial('acme__get_widget', { ['a'.repeat(200)]: 1 })).toMatch(
      /^an argument with a malformed name/,
    );
  });

  test('routing arguments are accepted whatever the tool declares, and nothing else is', () => {
    const routing = new Set(['projectId']);
    expect(denial('acme__whoami', { projectId: 'p1' }, routing)).toBeNull();
    expect(denial('acme__whoami', { projectId: 'p1', teamId: 't1' }, routing)).toMatch(/^teamId: /);
  });

  test("an unknown tool is not this rule's to refuse", () => {
    expect(denial('acme__nope', { anything: 1 })).toBeNull();
  });
});

describe('declaredOnly — the test-table helper', () => {
  test('keeps the declared entries, drops the rest, throws on an unknown tool', () => {
    expect(declaredOnly({ tools }, 'acme__get_widget', { id: 'w1', record_id: 'r1' })).toEqual({
      id: 'w1',
    });
    expect(declaredOnly({ tools }, 'acme__whoami', { id: 'w1' })).toEqual({});
    expect(() => declaredOnly({ tools }, 'acme__nope', {})).toThrow(/not a tool of this plugin/);
  });
});
