/**
 * Fixture plugin `acme` — a tiny, valid plugin used by the SDK's own tests.
 * Mirrors the shape of `plugins/_template` without being it.
 */

import { parseSlice } from '@vaubaan/policy-engine';
import {
  UpstreamAuthError,
  type DataModel,
  type McpToolDeclaration,
  type McpToolResult,
  type Resource,
} from '@vaubaan/shared';

import { expectCredentialKind } from '../../../src/credential.ts';
import { definePlugin } from '../../../src/define-plugin.ts';
import { loadCatalogFile } from '../../../src/catalog-loader.ts';
import { catalogPathNextTo } from '../../../src/catalog-path.ts';
import type {
  ClassifyOutcome,
  ConnectionContext,
  ExecuteContext,
  ProviderPlugin,
} from '../../../src/plugin.ts';

export const ACME_API = 'https://api.acme.test/v1';

export const acmeCatalog = loadCatalogFile(catalogPathNextTo(import.meta.url));

export const acmeDataModel: DataModel = {
  provider: 'acme',
  planes: [
    {
      slug: 'space',
      entities: [
        {
          name: 'space',
          parent: null,
          cardinalities: ['one'],
          description: 'A space.',
          envScopable: true,
        },
        {
          name: 'thing',
          parent: 'space',
          cardinalities: ['one', 'unbounded'],
          description: 'A thing in a space.',
        },
        {
          name: 'export',
          parent: 'space',
          cardinalities: ['one'],
          description: 'Legacy export of a space.',
        },
      ],
    },
  ],
};

export const acmeTools: readonly McpToolDeclaration[] = [
  {
    name: 'acme__list_things',
    description: 'List the things of a space.',
    inputSchema: { type: 'object', properties: { space: { type: 'string' } }, required: ['space'] },
  },
  {
    name: 'acme__update_thing',
    description: 'Rename a thing.',
    inputSchema: {
      type: 'object',
      properties: {
        space: { type: 'string' },
        thing_id: { type: 'string' },
        name: { type: 'string' },
      },
      required: ['space', 'thing_id', 'name'],
    },
  },
];

export function classifyAcme(
  tool: string,
  args: Readonly<Record<string, unknown>>,
  resources: readonly Resource[],
): ClassifyOutcome {
  const space =
    typeof args.space === 'string' ? args.space : resources.length === 1 ? resources[0]!.ref : null;
  if (!space) return { denied: 'space: argument missing and the mission touches several spaces' };
  switch (tool) {
    case 'acme__list_things':
      return { slices: [parseSlice(`acme.space[${space}].thing[*].R`)] };
    case 'acme__update_thing': {
      const id = typeof args.thing_id === 'string' ? args.thing_id : '*';
      return { slices: [parseSlice(`acme.space[${space}].thing[${id}].W`)] };
    }
    default:
      return { denied: `unknown tool '${tool}'` };
  }
}

async function acmeRequest(
  ctx: ConnectionContext,
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const secret = expectCredentialKind('acme', ctx.credential, 'api-key');
  const res = await ctx.fetch(`${ACME_API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${secret.fields.api_key}`,
      'content-type': 'application/json',
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  });
  if (res.status === 401 || res.status === 403)
    throw new UpstreamAuthError(`acme rejected the credential (${res.status})`, res.status);
  if (!res.ok) throw new Error(`acme ${method} ${path} failed: ${res.status}`);
  return await res.json();
}

export const acmePlugin: ProviderPlugin = definePlugin({
  id: 'acme',
  displayName: 'Acme',
  version: '1.2.3',
  description: 'Fixture provider.',
  tools: acmeTools,
  dataModel: acmeDataModel,
  catalog: acmeCatalog.catalog,
  credential: {
    kind: 'api-key',
    fields: [{ name: 'api_key', label: 'API key', secret: true }],
  },
  classify: classifyAcme,
  async execute(ctx: ExecuteContext, tool, args): Promise<McpToolResult> {
    const space = String(args.space);
    const result =
      tool === 'acme__list_things'
        ? await acmeRequest(ctx, 'GET', `/spaces/${space}/things`)
        : await acmeRequest(ctx, 'PATCH', `/spaces/${space}/things/${String(args.thing_id)}`, {
            name: args.name,
          });
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  },
  async discoverResources(ctx) {
    const spaces = (await acmeRequest(ctx, 'GET', '/spaces')) as ReadonlyArray<{
      id: string;
      name: string;
    }>;
    return spaces.map((s) => ({ provider: 'acme', ref: s.id, displayName: s.name }));
  },
});
