/**
 * How the `supabase` plugin reads Supabase's answers and declines what it
 * will not send : every failure typed (`UpstreamAuthError`,
 * `UpstreamHttpError`, `UpstreamProtocolError`), every refusal an `isError`
 * result, and the tool names declared once (`identity.ts`).
 *
 * Request shapes are pinned in `execute.test.ts` ; this suite pins what
 * comes back. No network : an unmatched request fails the test.
 */
import { describe, expect, test } from 'vitest';

import {
  UpstreamAuthError,
  UpstreamHttpError,
  UpstreamProtocolError,
  type AccountContext,
  type ExecuteContext,
  type Resource,
} from '@vaubaan/plugin-sdk';
import { mockFetch, type MockRoute } from '@vaubaan/plugin-sdk/testing';

import {
  SERVICE_ID,
  SUPABASE_API_BASE,
  TOOL,
  projectUrl,
  supabasePlugin,
  supabaseTools,
  verifySupabaseToken,
} from '../../src/index.ts';
import { resultJson, resultText } from './support.ts';

const REF = 'tlqgxnezmthbpzhdwxgi';
const MGMT = `${SUPABASE_API_BASE}/projects/${REF}`;
const DATA = projectUrl(REF);

const project: Resource = { service: SERVICE_ID, ref: REF, env: 'staging', displayName: 'app' };

function connCtx(fetch: typeof globalThis.fetch): AccountContext {
  return {
    credential: { kind: 'api-key', fields: { access_token: 'sbp_x' }, metadata: {} },
    fetch,
  };
}

function execCtx(fetch: typeof globalThis.fetch): ExecuteContext {
  return { ...connCtx(fetch), resources: [project] };
}

const serviceRole: MockRoute = {
  url: `${MGMT}/api-keys`,
  body: [{ name: 'service_role', api_key: 'eyJ.sr' }],
  times: 1,
};

/** What a call that must fail threw ; the test fails when it resolved. */
async function failureOf(call: Promise<unknown>): Promise<unknown> {
  return call.then(
    () => expect.fail('the call resolved'),
    (error: unknown) => error,
  );
}

/** A body Supabase never sends on a JSON API : what a proxy's error page looks like. */
const HTML_PAGE = { body: '<html>bad gateway</html>', headers: { 'content-type': 'text/html' } };

describe('the tool names are declared once', () => {
  test('TOOL names every declared tool, and nothing else', () => {
    expect(Object.values(TOOL).sort()).toEqual(supabaseTools.map((t) => t.name).sort());
    expect(Object.values(TOOL)).toHaveLength(45);
  });

  test('the plugin id is the service id', () => {
    expect(supabasePlugin.id).toBe(SERVICE_ID);
  });
});

describe('what the executor declines is an isError result, and no request leaves', () => {
  test('an unknown tool', async () => {
    const fetch = mockFetch([]);
    const result = await supabasePlugin.execute(execCtx(fetch), `${SERVICE_ID}__drop_everything`, {
      project_ref: REF,
    });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toBe(`unknown tool '${SERVICE_ID}__drop_everything'`);
    expect(fetch.calls).toHaveLength(0);
  });
});

describe('Management API answers', () => {
  test('a body that is not JSON is an UpstreamProtocolError naming the request', async () => {
    const fetch = mockFetch([{ url: MGMT, ...HTML_PAGE }]);
    const error = await failureOf(
      supabasePlugin.execute(execCtx(fetch), TOOL.getProject, { project_ref: REF }),
    );
    expect(error).toBeInstanceOf(UpstreamProtocolError);
    expect(error).toHaveProperty('message', `GET ${MGMT}: the answer is not JSON`);
  });

  test('a failed status is an UpstreamHttpError with that status, 401 an UpstreamAuthError', async () => {
    const failed = mockFetch([{ url: MGMT, status: 500, body: { message: 'down' } }]);
    await expect(
      supabasePlugin.execute(execCtx(failed), TOOL.getProject, { project_ref: REF }),
    ).rejects.toMatchObject({ name: 'UpstreamHttpError', status: 500 });
    const rejected = mockFetch([{ url: MGMT, status: 401, body: {} }]);
    await expect(
      supabasePlugin.execute(execCtx(rejected), TOOL.getProject, { project_ref: REF }),
    ).rejects.toBeInstanceOf(UpstreamAuthError);
  });

  test.each<[string, unknown]>([
    ['not a list', { name: 'anon', api_key: 'eyJ.anon' }],
    ['a list holding something else than objects', ['anon']],
    ['no anon entry', [{ name: 'service_role', api_key: 'eyJ.sr' }]],
    ['an anon entry without a key', [{ name: 'anon', api_key: null }]],
  ])('get_anon_key on api-keys %s is an UpstreamProtocolError', async (_label, body) => {
    const fetch = mockFetch([{ url: `${MGMT}/api-keys`, body }]);
    await expect(
      supabasePlugin.execute(execCtx(fetch), TOOL.getAnonKey, { project_ref: REF }),
    ).rejects.toBeInstanceOf(UpstreamProtocolError);
  });
});

describe('data-plane answers', () => {
  test('a text answer is passed through as text', async () => {
    const fetch = mockFetch([
      serviceRole,
      {
        method: 'DELETE',
        url: `${DATA}/storage/v1/bucket/avatars`,
        body: 'Successfully deleted',
        headers: { 'content-type': 'text/plain' },
      },
    ]);
    const result = await supabasePlugin.execute(execCtx(fetch), TOOL.deleteBucket, {
      project_ref: REF,
      id: 'avatars',
    });
    expect(resultJson(result)).toBe('Successfully deleted');
  });

  test('an answer that says JSON and is not is an UpstreamProtocolError', async () => {
    const fetch = mockFetch([
      serviceRole,
      {
        url: `${DATA}/auth/v1/admin/users/u1`,
        body: '{"id":',
        headers: { 'content-type': 'application/json' },
      },
    ]);
    const error = await failureOf(
      supabasePlugin.execute(execCtx(fetch), TOOL.getUser, { project_ref: REF, user_id: 'u1' }),
    );
    expect(error).toBeInstanceOf(UpstreamProtocolError);
    expect(error).toHaveProperty(
      'message',
      `GET ${DATA}/auth/v1/admin/users/u1: the answer is not JSON`,
    );
  });

  test('a failed status is typed, the service_role key never quoted', async () => {
    const fetch = mockFetch([
      serviceRole,
      { url: `${DATA}/auth/v1/admin/users/u1`, status: 404, body: { msg: 'User not found' } },
    ]);
    const call = supabasePlugin.execute(execCtx(fetch), TOOL.getUser, {
      project_ref: REF,
      user_id: 'u1',
    });
    await expect(call).rejects.toBeInstanceOf(UpstreamHttpError);
    await expect(call).rejects.not.toThrow(/eyJ\.sr/);
  });

  test('a 403 from the project host is an UpstreamAuthError', async () => {
    const fetch = mockFetch([
      serviceRole,
      { url: /\/storage\/v1\/object\/list\//, status: 403, body: { message: 'denied' } },
    ]);
    await expect(
      supabasePlugin.execute(execCtx(fetch), TOOL.listObjects, { project_ref: REF, bucket: 'b' }),
    ).rejects.toBeInstanceOf(UpstreamAuthError);
  });

  test('no service_role key is an UpstreamProtocolError, and the project host is not called', async () => {
    const fetch = mockFetch([{ url: `${MGMT}/api-keys`, body: [] }]);
    await expect(
      supabasePlugin.execute(execCtx(fetch), TOOL.listUsers, { project_ref: REF }),
    ).rejects.toBeInstanceOf(UpstreamProtocolError);
    expect(fetch.calls).toHaveLength(1);
  });

  test('an upload sends the decoded bytes under the media type, and reads a JSON answer', async () => {
    const fetch = mockFetch([
      serviceRole,
      { method: 'POST', url: `${DATA}/storage/v1/object/b/a.txt`, body: { Key: 'b/a.txt' } },
    ]);
    const result = await supabasePlugin.execute(execCtx(fetch), TOOL.uploadObject, {
      project_ref: REF,
      bucket: 'b',
      path: 'a.txt',
      content_base64: 'aGk=',
      content_type: 'text/plain',
    });
    const upload = fetch.calls[1]!;
    expect(upload.body).toBe('hi');
    expect(upload.headers['content-type']).toBe('text/plain');
    expect(upload.headers['x-upsert']).toBe('false');
    expect(resultJson(result)).toEqual({ Key: 'b/a.txt' });
  });

  test('an upload answered with something else than JSON is an UpstreamProtocolError', async () => {
    const fetch = mockFetch([
      serviceRole,
      { method: 'POST', url: `${DATA}/storage/v1/object/b/a.txt`, ...HTML_PAGE },
    ]);
    await expect(
      supabasePlugin.execute(execCtx(fetch), TOOL.uploadObject, {
        project_ref: REF,
        bucket: 'b',
        path: 'a.txt',
        content_base64: 'aGk=',
      }),
    ).rejects.toBeInstanceOf(UpstreamProtocolError);
  });
});

describe('discovery and the check at paste', () => {
  const organizations: MockRoute = { url: `${SUPABASE_API_BASE}/organizations`, body: [] };

  test.each<[string, unknown]>([
    ['not a list', { projects: [] }],
    ['a list holding something else than objects', [REF]],
    ['nothing', null],
  ])('a project listing that is %s is an UpstreamProtocolError', async (_label, body) => {
    const fetch = mockFetch([
      organizations,
      body === null
        ? { url: `${SUPABASE_API_BASE}/projects`, status: 204 }
        : { url: `${SUPABASE_API_BASE}/projects`, body },
    ]);
    await expect(supabasePlugin.discoverResources(connCtx(fetch))).rejects.toBeInstanceOf(
      UpstreamProtocolError,
    );
  });

  test('a project ref that is not a host label is an UpstreamProtocolError', async () => {
    const fetch = mockFetch([
      organizations,
      { url: `${SUPABASE_API_BASE}/projects`, body: [{ ref: 'Not/A.Ref', name: 'x' }] },
    ]);
    await expect(supabasePlugin.discoverResources(connCtx(fetch))).rejects.toBeInstanceOf(
      UpstreamProtocolError,
    );
  });

  test('a field of another type is ignored, never trusted', async () => {
    const fetch = mockFetch([
      { url: `${SUPABASE_API_BASE}/organizations`, body: [{ id: 'o', name: 42 }] },
      {
        url: `${SUPABASE_API_BASE}/projects`,
        body: [{ ref: REF, name: ['app'], organization_id: 'o', region: 7 }],
      },
    ]);
    expect(await supabasePlugin.discoverResources(connCtx(fetch))).toEqual([
      {
        service: SERVICE_ID,
        ref: REF,
        displayName: `o / ${REF}`,
        metadata: { organization: 'o', organization_name: 'o' },
      },
    ]);
  });

  test('verify : an organisation listing that is not a list is an UpstreamProtocolError', async () => {
    const fetch = mockFetch([
      { url: `${SUPABASE_API_BASE}/organizations`, body: { name: 'Acme' } },
    ]);
    await expect(verifySupabaseToken(connCtx(fetch))).rejects.toBeInstanceOf(UpstreamProtocolError);
  });

  test('verify : a failed status other than 401 / 403 is an UpstreamHttpError', async () => {
    const fetch = mockFetch([{ url: `${SUPABASE_API_BASE}/organizations`, status: 503, body: {} }]);
    await expect(verifySupabaseToken(connCtx(fetch))).rejects.toMatchObject({
      name: 'UpstreamHttpError',
      status: 503,
    });
  });

  test('verify : organisations without a name are left out of the account', async () => {
    const fetch = mockFetch([
      { url: `${SUPABASE_API_BASE}/organizations`, body: [{ name: 'Acme' }, { id: 'x' }, 'y'] },
    ]);
    // 'y' is no organisation object : left out, like one without a name.
    expect(await verifySupabaseToken(connCtx(fetch))).toEqual({ account: 'Acme', expiresAt: null });
  });
});
