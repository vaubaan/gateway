/**
 * The advertised output schemas, as a matter of form: one per tool, an object
 * at the root, and **loose at every level** — the property that keeps a field
 * added to an answer from turning a successful call into an error after it
 * ran. That every real answer of every tool matches its schema is
 * `tests/integration/management/output-schemas.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { MANAGEMENT_TOOL_NAMES, MANAGEMENT_TOOLS } from './definitions';
import { MANAGEMENT_OUTPUT_SCHEMAS } from './output-schemas';

type JsonSchema = { readonly [key: string]: unknown };

/** Every object schema nested in a JSON Schema, with the path that leads to it. */
function objectSchemas(schema: unknown, path = '$'): { path: string; schema: JsonSchema }[] {
  if (typeof schema !== 'object' || schema === null) return [];
  if (Array.isArray(schema)) {
    return schema.flatMap((item, index) => objectSchemas(item, `${path}[${index}]`));
  }
  const node = schema as JsonSchema;
  const here = node.type === 'object' ? [{ path, schema: node }] : [];
  return [
    ...here,
    ...Object.entries(node).flatMap(([key, value]) => objectSchemas(value, `${path}.${key}`)),
  ];
}

describe('output schemas of the management tools', () => {
  it('there is one per tool, and it is the one the tool definition carries', () => {
    expect(Object.keys(MANAGEMENT_OUTPUT_SCHEMAS).sort()).toEqual(
      [...MANAGEMENT_TOOL_NAMES].sort(),
    );
    for (const tool of MANAGEMENT_TOOLS) {
      expect(tool.outputSchema, tool.name).toBe(MANAGEMENT_OUTPUT_SCHEMAS[tool.name]);
    }
  });

  it.each(MANAGEMENT_TOOL_NAMES)(
    '%s: an object at the root, and no level refuses a key it does not name',
    (name) => {
      const json = z.toJSONSchema(MANAGEMENT_OUTPUT_SCHEMAS[name], { io: 'output' });
      expect(json.type).toBe('object');
      const objects = objectSchemas(json);
      expect(objects.length).toBeGreaterThan(0);
      for (const { path, schema } of objects) {
        // `z.object` would render `false` here: a client validating the answer
        // would then reject any field added later.
        expect(schema.additionalProperties, `${name} ${path}`).toEqual({});
      }
    },
  );

  it('the two answers that reveal a token name it, and accept whatever else rides along', () => {
    for (const name of ['issue_mission', 'rotate_mission_token'] as const) {
      const json = z.toJSONSchema(MANAGEMENT_OUTPUT_SCHEMAS[name], { io: 'output' }) as {
        properties: Record<string, { properties?: Record<string, unknown>; required?: string[] }>;
      };
      expect(json.properties.token?.required).toEqual(
        expect.arrayContaining(['secret', 'prefix', 'env_var', 'shown_once']),
      );
      expect(Object.keys(json.properties.bootstrap_kit?.properties ?? {})).toEqual([
        'endpoint',
        'env',
        'mcp_json',
        'agent_instructions',
        'verify',
      ]);
    }
    const rotated = {
      mission_id: 'm1',
      token: { secret: 's', prefix: 'p', env_var: 'V', shown_once: true, added_later: 1 },
      bootstrap_kit: {
        endpoint: 'e',
        env: 'x',
        mcp_json: '{}',
        agent_instructions: 'i',
        verify: 'v',
        reveals_secret: true,
      },
      added_later: { anything: [1, 2, 3] },
    };
    expect(MANAGEMENT_OUTPUT_SCHEMAS.rotate_mission_token.safeParse(rotated).success).toBe(true);
  });

  it('a refusal is not an answer: the schemas do not describe `{ error }`', () => {
    const refusal = { error: { code: 'mission-not-found', message: 'm', hint: 'h' } };
    for (const name of MANAGEMENT_TOOL_NAMES) {
      expect(MANAGEMENT_OUTPUT_SCHEMAS[name].safeParse(refusal).success, name).toBe(false);
    }
  });
});
