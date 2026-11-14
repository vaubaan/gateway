/**
 * Identifiers that reach a request : what `classify` names is what `execute`
 * sends, or the call is refused by both.
 *
 * `encodeURIComponent` leaves `.` and `..` untouched and every URL parser
 * removes dot segments, so `DELETE …/functions/..` is sent as
 * `DELETE …/projects/{ref}/` and `…/object/public/../../bucket/x` as
 * `…/bucket/x`. Each identifier kind therefore has one grammar, shared by the
 * classifier and the executor (`readIdentifiers`). A refused value costs no
 * network call — not even the `service_role` key lookup of the data plane.
 *
 * The SQL of `execute_sql` / `apply_migration` is out of scope here
 * (docs/decisions/pivot-to-risk-based-model.md).
 */
import { describe, expect, test } from 'vitest';

import { serializeSlice, type ExecuteContext, type Resource } from '@vaubaan/plugin-sdk';
import { mockFetch, type MockRoute } from '@vaubaan/plugin-sdk/testing';

import { classifySupabase } from '../../src/classify.ts';
import { supabasePlugin, SUPABASE_API_BASE } from '../../src/index.ts';
import { resultText, sentQuery } from './support.ts';

const REF = 'tlqgxnezmthbpzhdwxgi';
const MGMT = `${SUPABASE_API_BASE}/projects/${REF}`;
const DATA = `https://${REF}.supabase.co`;
const UUID = '6f1c2a3e-9b7d-4c5a-8e21-0d3f4a5b6c7d';

const project: Resource = {
  provider: 'supabase',
  ref: REF,
  env: 'staging',
  displayName: 'Acme / app',
};

const execCtx = (
  fetch: typeof globalThis.fetch,
  resources: readonly Resource[] = [project],
): ExecuteContext => ({
  credential: { kind: 'api-key', fields: { access_token: 'sbp_access' }, metadata: {} },
  fetch,
  resources,
});

const API_KEYS_URL = `${MGMT}/api-keys`;

/** Supabase answering anything : a test then reads what was sent. */
const upstream: readonly MockRoute[] = [
  { method: 'GET', url: API_KEYS_URL, body: [{ name: 'service_role', api_key: 'sr.jwt' }] },
  { url: /./, body: {} },
];

/** Values no identifier position may let through. */
const HOSTILE: ReadonlyArray<readonly [label: string, value: string]> = [
  ['a double dot', '..'],
  ['a single dot', '.'],
  ['a dot segment inside', 'a/../b'],
  ['an encoded double dot', '%2e%2e'],
  ['an encoded separator', '%2f'],
  ['a double dot and an encoded separator', '..%2f'],
  ['an empty string', ''],
  ['a 5000-character value', 'x'.repeat(5000)],
  ['a newline', 'a\nb'],
  ['a query and a fragment', 'a?x=1#y'],
  ['a backslash', 'a\\b'],
];

/** A separator is legitimate inside an object path only. */
const SEPARATOR = ['a separator', 'a/b'] as const;

interface Position {
  readonly position: string;
  readonly tool: string;
  readonly args: (value: unknown) => Record<string, unknown>;
  /** Extra hostile values of this position, on top of `HOSTILE`. */
  readonly also?: ReadonlyArray<readonly [string, string]>;
}

const one = (
  tool: string,
  arg: string,
  rest: Record<string, unknown> = {},
  also: Position['also'] = [SEPARATOR],
): Position => ({
  position: `${tool.replace('supabase__', '')} ${arg}`,
  tool,
  args: (value) => ({ ...rest, [arg]: value }),
  also,
});

const file = { content_base64: 'AA' };
const PATH_HOSTILE: Position['also'] = [
  ['a leading double dot', '../other/x.png'],
  ['a climb to another bucket', 'a/../../bucket/victim'],
  ['a leading separator', '/a.png'],
  ['an empty segment', 'a//b.png'],
  ['a trailing separator', 'a/'],
  ['a dot segment at the end', 'a/.'],
];

/** Every identifier an argument places in a URL path, a query or a host. */
const POSITIONS: readonly Position[] = [
  one('supabase__get_project', 'project_ref'),
  one('supabase__delete_user', 'project_ref', { user_id: 'u1' }),
  one('supabase__get_sso_provider', 'provider_id'),
  one('supabase__update_sso_provider', 'provider_id'),
  one('supabase__delete_sso_provider', 'provider_id'),
  one('supabase__get_third_party_auth', 'tpa_id'),
  one('supabase__delete_third_party_auth', 'tpa_id'),
  one('supabase__get_function', 'function_slug'),
  one('supabase__get_function_body', 'function_slug'),
  one('supabase__update_function', 'function_slug'),
  one('supabase__delete_function', 'function_slug'),
  one('supabase__create_function', 'slug', { body: 'x' }),
  one('supabase__deploy_function', 'slug', { entrypoint_path: 'index.ts', files: [] }),
  one('supabase__get_user', 'user_id'),
  one('supabase__update_user', 'user_id'),
  one('supabase__delete_user', 'user_id'),
  one('supabase__create_bucket', 'id', { name: 'B' }),
  one('supabase__update_bucket', 'id'),
  one('supabase__delete_bucket', 'id'),
  one('supabase__list_objects', 'bucket'),
  one('supabase__upload_object', 'bucket', { path: 'p.txt', ...file }),
  one('supabase__delete_object', 'bucket', { path: 'p.txt' }),
  one('supabase__create_signed_url', 'bucket', { path: 'p.txt' }),
  one('supabase__upload_object', 'path', { bucket: 'b', ...file }, PATH_HOSTILE),
  one('supabase__delete_object', 'path', { bucket: 'b' }, PATH_HOSTILE),
  one('supabase__create_signed_url', 'path', { bucket: 'b' }, PATH_HOSTILE),
  one('supabase__get_advisors', 'type'),
  one('supabase__generate_link', 'email', { type: 'magiclink' }),
  one('supabase__generate_link', 'type', { email: 'a@b.c' }),
  one('supabase__upload_object', 'content_type', { bucket: 'b', path: 'p.txt', ...file }, [
    ['a header injection', 'text/plain\r\nx-evil: 1'],
  ]),
  {
    position: 'list_tables schemas[]',
    tool: 'supabase__list_tables',
    args: (value) => ({ schemas: ['public', value] }),
    also: [
      SEPARATOR,
      ['a quote', "pub'lic"],
      ['a backslash and a quote', "x\\' ) union select 1 --"],
    ],
  },
];

const CASES = POSITIONS.flatMap((p) =>
  [...HOSTILE, ...(p.also ?? [])].map(([label, value]) => ({
    position: p.position,
    label,
    tool: p.tool,
    args: p.args(value),
  })),
);

const NON_STRING_CASES = POSITIONS.filter((p) => !p.position.endsWith('content_type')).flatMap(
  (p) =>
    ([42, null, ['x'], { id: 'x' }] as const).map((value) => ({
      position: p.position,
      label: JSON.stringify(value),
      tool: p.tool,
      args: p.args(value),
    })),
);

function denialOf(
  tool: string,
  args: Record<string, unknown>,
  resources: readonly Resource[] = [project],
): string | null {
  const out = classifySupabase(tool, args, resources);
  return 'denied' in out ? out.denied : null;
}

function slicesOf(tool: string, args: Record<string, unknown>): string[] {
  const out = classifySupabase(tool, args, [project]);
  if ('denied' in out) throw new Error(`unexpected denial: ${out.denied}`);
  return out.slices.map(serializeSlice);
}

/** `execute` declines the call itself and no request leaves. */
async function expectRefusedWithoutCall(
  tool: string,
  args: Record<string, unknown>,
  resources: readonly Resource[] = [project],
): Promise<void> {
  const fetch = mockFetch(upstream);
  const result = await supabasePlugin.execute(execCtx(fetch, resources), tool, args);
  expect(result.isError).toBe(true);
  expect(fetch.calls).toHaveLength(0);
}

/** The request `execute` made for the tool itself (the `service_role` key lookup left out). */
async function sent(tool: string, args: Record<string, unknown>) {
  const fetch = mockFetch(upstream);
  const result = await supabasePlugin.execute(execCtx(fetch), tool, args);
  expect(result.isError).toBeUndefined();
  const own = fetch.calls.filter((c) => c.url !== API_KEYS_URL);
  expect(own).toHaveLength(1);
  return own[0]!;
}

describe('supabase identifiers — a value that could leave its position is refused by classify and by execute', () => {
  test.each(CASES)('$position : $label is denied by the classifier', ({ tool, args }) => {
    expect(denialOf(tool, args)).not.toBeNull();
  });

  test.each(CASES)(
    '$position : $label is refused by execute before any network call',
    async ({ tool, args }) => {
      await expectRefusedWithoutCall(tool, args);
    },
  );

  test.each(NON_STRING_CASES)(
    '$position : the non-string $label is refused by both',
    async ({ tool, args }) => {
      expect(denialOf(tool, args)).not.toBeNull();
      await expectRefusedWithoutCall(tool, args);
    },
  );

  test.each(CASES)(
    '$position : $label — execute gives the reason the classifier gives',
    async ({ tool, args }) => {
      const fetch = mockFetch(upstream);
      const result = await supabasePlugin.execute(execCtx(fetch), tool, args);
      expect(resultText(result)).toBe(denialOf(tool, args));
    },
  );
});

describe('supabase identifiers — the dot-segment reproductions', () => {
  test('delete_function `..` never becomes DELETE /v1/projects/{ref}/', async () => {
    expect(denialOf('supabase__delete_function', { function_slug: '..' })).toBe(
      'function_slug: missing or malformed.',
    );
    await expectRefusedWithoutCall('supabase__delete_function', { function_slug: '..' });
  });

  test('delete_object in bucket `..` never becomes DELETE /storage/v1/bucket/{victim}', async () => {
    const args = { bucket: '..', path: 'bucket/victim' };
    expect(denialOf('supabase__delete_object', args)).toBe('bucket: missing or malformed.');
    await expectRefusedWithoutCall('supabase__delete_object', args);
  });

  test('an object path never climbs out of its bucket', async () => {
    for (const [tool, extra] of [
      ['supabase__upload_object', file],
      ['supabase__delete_object', {}],
      ['supabase__create_signed_url', {}],
    ] as const) {
      const args = { bucket: 'public', path: '../private/secret.pdf', ...extra };
      expect(denialOf(tool, args)).toBe('path: missing or malformed.');
      await expectRefusedWithoutCall(tool, args);
    }
  });

  test('delete_user `..` never becomes DELETE /auth/v1/admin/', async () => {
    await expectRefusedWithoutCall('supabase__delete_user', { user_id: '..' });
  });

  test('delete_bucket `..` never becomes DELETE /storage/v1/', async () => {
    await expectRefusedWithoutCall('supabase__delete_bucket', { id: '..' });
  });
});

describe('supabase identifiers — one argument names the target, for classify and for execute', () => {
  test('get_function reads `function_slug` only : `slug` is not a second spelling', async () => {
    for (const tool of ['supabase__get_function', 'supabase__get_function_body']) {
      for (const args of [{ slug: 'allowed' }, { function_slug: 'a b', slug: 'allowed' }]) {
        expect(denialOf(tool, args)).toBe('function_slug: missing or malformed.');
        await expectRefusedWithoutCall(tool, args);
      }
    }
  });

  test('create_bucket : a malformed `id` is not replaced by `name`', async () => {
    const args = { id: 'not an id', name: 'allowed' };
    expect(denialOf('supabase__create_bucket', args)).toBe('id: missing or malformed.');
    await expectRefusedWithoutCall('supabase__create_bucket', args);
  });

  test('create_bucket : the bucket classified is the bucket created', async () => {
    expect(slicesOf('supabase__create_bucket', { id: 'avatars', name: 'Avatars' })).toEqual([
      `supabase.project[${REF}].bucket[avatars].W`,
    ]);
    const call = await sent('supabase__create_bucket', { id: 'avatars', name: 'Avatars' });
    expect(call.json).toEqual({ id: 'avatars', name: 'Avatars' });
    // Without `id`, Storage names the bucket after `name` : that is the id classified.
    expect(slicesOf('supabase__create_bucket', { name: 'avatars' })).toEqual([
      `supabase.project[${REF}].bucket[avatars].W`,
    ]);
    expect((await sent('supabase__create_bucket', { name: 'avatars' })).json).toEqual({
      name: 'avatars',
    });
  });

  test('get_advisors : a closed set, `security` when absent', async () => {
    expect((await sent('supabase__get_advisors', {})).url).toBe(`${MGMT}/advisors/security`);
    expect((await sent('supabase__get_advisors', { type: 'performance' })).url).toBe(
      `${MGMT}/advisors/performance`,
    );
    expect(denialOf('supabase__get_advisors', { type: 'other' })).toBe(
      'type: missing or malformed.',
    );
    await expectRefusedWithoutCall('supabase__get_advisors', { type: 'other' });
  });
});

describe('supabase identifiers — legitimate shapes keep working, and the request names what was classified', () => {
  test.each([
    [
      'supabase__get_sso_provider',
      { provider_id: UUID },
      `${MGMT}/config/auth/sso/providers/${UUID}`,
    ],
    [
      'supabase__delete_sso_provider',
      { provider_id: UUID },
      `${MGMT}/config/auth/sso/providers/${UUID}`,
    ],
    [
      'supabase__get_third_party_auth',
      { tpa_id: UUID },
      `${MGMT}/config/auth/third-party-auth/${UUID}`,
    ],
    [
      'supabase__get_function',
      { function_slug: 'stripe-webhook_v2' },
      `${MGMT}/functions/stripe-webhook_v2`,
    ],
    ['supabase__get_function_body', { function_slug: 'hello' }, `${MGMT}/functions/hello/body`],
    ['supabase__delete_function', { function_slug: 'hello' }, `${MGMT}/functions/hello`],
    ['supabase__get_user', { user_id: UUID }, `${DATA}/auth/v1/admin/users/${UUID}`],
    ['supabase__delete_user', { user_id: UUID }, `${DATA}/auth/v1/admin/users/${UUID}`],
    ['supabase__delete_bucket', { id: 'my.bucket-1' }, `${DATA}/storage/v1/bucket/my.bucket-1`],
    ['supabase__list_objects', { bucket: 'avatars' }, `${DATA}/storage/v1/object/list/avatars`],
    [
      'supabase__delete_object',
      { bucket: 'avatars', path: 'folder/sub.dir/file.v1.png' },
      `${DATA}/storage/v1/object/avatars/folder/sub.dir/file.v1.png`,
    ],
    [
      'supabase__delete_object',
      { bucket: 'avatars', path: 'a..b/..c/d..' },
      `${DATA}/storage/v1/object/avatars/a..b/..c/d..`,
    ],
    [
      'supabase__create_signed_url',
      { bucket: 'avatars', path: 'u/123.png' },
      `${DATA}/storage/v1/object/sign/avatars/u/123.png`,
    ],
    [
      'supabase__deploy_function',
      { slug: 'hello', entrypoint_path: 'index.ts', files: [] },
      `${MGMT}/functions/deploy?slug=hello`,
    ],
    [
      'supabase__list_users',
      { page: 3, per_page: 25 },
      `${DATA}/auth/v1/admin/users?page=3&per_page=25`,
    ],
    ['supabase__list_users', {}, `${DATA}/auth/v1/admin/users?page=1&per_page=50`],
  ] as const)('%s %j → %s', async (tool, args, url) => {
    expect(denialOf(tool, args)).toBeNull();
    const call = await sent(tool, args);
    expect(call.url).toBe(url);
    // What a URL parser makes of it is the same path : no segment was removed.
    expect(new URL(call.url).href).toBe(url);
  });

  test('the slice names the identifier that is sent', () => {
    expect(slicesOf('supabase__get_function', { function_slug: 'hello' })).toEqual([
      `supabase.project[${REF}].edge-function[hello].R`,
    ]);
    expect(slicesOf('supabase__get_sso_provider', { provider_id: UUID })).toEqual([
      `supabase.project[${REF}].sso-provider[${UUID}].R`,
    ]);
    expect(slicesOf('supabase__delete_bucket', { id: 'my.bucket-1' })).toEqual([
      `supabase.project[${REF}].bucket[my.bucket-1].W`,
      `supabase.project[${REF}].bucket[my.bucket-1].object[bulk].W`,
    ]);
  });

  test('an email with dots, a plus tag and a subdomain is accepted ; a value without `@` is not', async () => {
    const email = 'first.last+tag@mail.example.co.uk';
    expect(slicesOf('supabase__generate_link', { email, type: 'magiclink' })).toEqual([
      // `@` and `+` are not slice characters : the address is sent, not written into the slice.
      `supabase.project[${REF}].user[*].link[magiclink].W`,
    ]);
    expect((await sent('supabase__generate_link', { email, type: 'magiclink' })).json).toEqual({
      email,
      type: 'magiclink',
    });
    for (const bad of ['bulk', 'a@', '@b.c', 'a@b@c.d', 'a@b..c', 'a@.b']) {
      expect(denialOf('supabase__generate_link', { email: bad, type: 'magiclink' })).toBe(
        'email: missing or malformed.',
      );
      await expectRefusedWithoutCall('supabase__generate_link', { email: bad, type: 'magiclink' });
    }
  });

  test('upload_object sends the media type it classified, `application/octet-stream` when absent', async () => {
    const args = { bucket: 'b', path: 'p.txt', ...file };
    expect((await sent('supabase__upload_object', args)).headers['content-type']).toBe(
      'application/octet-stream',
    );
    for (const content_type of ['image/png', 'text/plain; charset=utf-8', 'image/svg+xml']) {
      const call = await sent('supabase__upload_object', { ...args, content_type });
      expect(call.headers['content-type']).toBe(content_type);
    }
  });
});

describe('supabase identifiers — query strings and SQL text built by the plugin', () => {
  test.each([1.5, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1e21, '1', '1&per_page=1000', null])(
    'list_users page %j is refused by both',
    async (page) => {
      expect(denialOf('supabase__list_users', { page })).toBe('page: missing or malformed.');
      await expectRefusedWithoutCall('supabase__list_users', { page });
      expect(denialOf('supabase__list_users', { per_page: page })).toBe(
        'per_page: missing or malformed.',
      );
      await expectRefusedWithoutCall('supabase__list_users', { per_page: page });
    },
  );

  test('list_tables interpolates schema identifiers only', async () => {
    const call = await sent('supabase__list_tables', { schemas: ['public', 'app_v2', '_private'] });
    expect(sentQuery(call)).toContain("in ('public','app_v2','_private')");
    // Absent or empty : the `public` schema, as before.
    for (const args of [{}, { schemas: [] }]) {
      const fallback = await sent('supabase__list_tables', args);
      expect(sentQuery(fallback)).toContain("in ('public')");
    }
  });

  test.each([['public'], [{ 0: 'public' }], [[7]], [[null]], [['public', ['app']]]])(
    'list_tables schemas %j is refused by both, never filtered',
    async (schemas) => {
      expect(denialOf('supabase__list_tables', { schemas })).toBe('schemas: missing or malformed.');
      await expectRefusedWithoutCall('supabase__list_tables', { schemas });
    },
  );
});

describe('supabase identifiers — the project ref is a host label', () => {
  test.each(['UPPERCASEREF', 'under_score', '-leading', 'trailing-', 'a.b', 'x'.repeat(64)])(
    'a mission resource whose ref is %s is never used, named or implied',
    async (ref) => {
      const odd: Resource = { ...project, ref };
      for (const args of [{}, { project_ref: ref }]) {
        expect(denialOf('supabase__get_project', args, [odd])).toBe(
          'project_ref: missing or malformed.',
        );
        await expectRefusedWithoutCall('supabase__get_project', args, [odd]);
        await expectRefusedWithoutCall('supabase__delete_user', { ...args, user_id: 'u1' }, [odd]);
      }
    },
  );

  test('discovery refuses a project ref the classifier would refuse', async () => {
    const fetch = mockFetch([
      { method: 'GET', url: `${SUPABASE_API_BASE}/organizations`, body: [] },
      {
        method: 'GET',
        url: `${SUPABASE_API_BASE}/projects`,
        body: [
          { ref: REF, name: 'app' },
          { ref: 'evil.example/x', name: 'odd' },
        ],
      },
    ]);
    const { resources: _resources, ...account } = execCtx(fetch);
    await expect(supabasePlugin.discoverResources(account)).rejects.toThrow(/not a project ref/);
  });
});
