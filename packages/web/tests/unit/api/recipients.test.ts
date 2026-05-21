/**
 * Unit tests for the recipient-list endpoint
 * (packages/web/src/app/api/crm/v1/resources/[rId]/access/[key]/recipients/route.ts).
 *
 * The Supabase client is mocked: we drive every scenario through a tiny
 * fake that supports the chained calls used by the handler (auth.getUser,
 * from().select().eq(...).maybeSingle(), from().select().eq(...),
 * from().select().in(...)). RLS itself is exercised by the integration
 * plan in docs/tests/integration-tests.md.
 *
 * Spec: docs/spec/cloud-resource-manager.md §4.4.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import { generateUserKeypair } from '@crm/core/crypto';

interface ResourceRow {
  readonly id: string;
  readonly organization_id: string;
  readonly is_admin: boolean;
}

interface MemberRow {
  readonly user_id: string;
}

interface KeyRow {
  readonly user_id: string;
  readonly public_key: Uint8Array | string;
  readonly fingerprint: string;
}

interface RecipientEntry {
  readonly user_id?: string;
  readonly public_key: string;
  readonly fingerprint: string;
}

interface FakeState {
  user: { id: string } | null;
  resource: ResourceRow | null;
  members: ReadonlyArray<MemberRow>;
  keys: ReadonlyArray<KeyRow>;
}

function makeFakeSupabase(state: FakeState): unknown {
  return {
    auth: {
      getUser: () =>
        Promise.resolve(
          state.user
            ? { data: { user: state.user }, error: null }
            : { data: { user: null }, error: null },
        ),
    },
    from(table: string) {
      if (table === 'resources') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve({ data: state.resource, error: null }),
            }),
          }),
        };
      }
      if (table === 'org_members') {
        return {
          select: () => ({
            eq: () => Promise.resolve({ data: state.members, error: null }),
          }),
        };
      }
      if (table === 'user_crypto_keys') {
        return {
          select: () => ({
            in: () => Promise.resolve({ data: state.keys, error: null }),
          }),
        };
      }
      throw new Error(`Unexpected table ${table}`);
    },
  };
}

const fakeState: FakeState = {
  user: null,
  resource: null,
  members: [],
  keys: [],
};

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: () => Promise.resolve(makeFakeSupabase(fakeState)),
}));

interface RouteHandler {
  GET(req: Request, ctx: { params: Promise<{ rId: string; key: string }> }): Promise<Response>;
}

async function callGet(rId = 'res-1', key = 'token'): Promise<Response> {
  const mod =
    (await import('@/app/api/crm/v1/resources/[rId]/access/[key]/recipients/route')) as RouteHandler;
  const req = new Request(`http://localhost/api/crm/v1/resources/${rId}/access/${key}/recipients`);
  return mod.GET(req, { params: Promise.resolve({ rId, key }) });
}

interface ErrorBody {
  readonly error: string;
}
interface DefaultsBody {
  readonly defaults: ReadonlyArray<RecipientEntry>;
}

async function readError(res: Response): Promise<ErrorBody> {
  return (await res.json()) as ErrorBody;
}
async function readDefaults(res: Response): Promise<DefaultsBody> {
  return (await res.json()) as DefaultsBody;
}

function resetState(): void {
  fakeState.user = null;
  fakeState.resource = null;
  fakeState.members = [];
  fakeState.keys = [];
}

describe('GET /api/crm/v1/resources/:rId/access/:key/recipients', () => {
  beforeEach(() => {
    resetState();
  });

  it('returns 401 when no session', async () => {
    fakeState.user = null;
    const res = await callGet();
    expect(res.status).toBe(401);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const body = await readError(res);
    expect(body).toEqual({ error: 'unauthorized' });
  });

  it('returns 404 when the resource is not visible to the user (RLS empty)', async () => {
    fakeState.user = { id: 'user-1' };
    fakeState.resource = null;
    const res = await callGet();
    expect(res.status).toBe(404);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const body = await readError(res);
    expect(body).toEqual({ error: 'not_found' });
  });

  it('returns default list for a non-admin resource (both members with keys)', async () => {
    const alice = await generateUserKeypair();
    const bob = await generateUserKeypair();
    fakeState.user = { id: 'user-alice' };
    fakeState.resource = {
      id: 'res-1',
      organization_id: 'org-1',
      is_admin: false,
    };
    fakeState.members = [{ user_id: 'user-alice' }, { user_id: 'user-bob' }];
    fakeState.keys = [
      { user_id: 'user-alice', public_key: alice.publicKey, fingerprint: alice.fingerprint },
      { user_id: 'user-bob', public_key: bob.publicKey, fingerprint: bob.fingerprint },
    ];

    const res = await callGet();
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const body = await readDefaults(res);
    expect(body.defaults).toHaveLength(2);
    const fps = body.defaults.map((r) => r.fingerprint).sort();
    expect(fps).toEqual([alice.fingerprint, bob.fingerprint].sort());
    const aliceEntry = body.defaults.find((r) => r.fingerprint === alice.fingerprint);
    expect(aliceEntry?.user_id).toBe('user-alice');
    expect(typeof aliceEntry?.public_key).toBe('string');
    expect(
      Buffer.from(aliceEntry?.public_key ?? '', 'base64').equals(Buffer.from(alice.publicKey)),
    ).toBe(true);
  });

  it('returns default list for an org-admin resource (still just members, no runner in phase 2)', async () => {
    const alice = await generateUserKeypair();
    const bob = await generateUserKeypair();
    fakeState.user = { id: 'user-alice' };
    fakeState.resource = {
      id: 'res-admin',
      organization_id: 'org-1',
      is_admin: true,
    };
    fakeState.members = [{ user_id: 'user-alice' }, { user_id: 'user-bob' }];
    fakeState.keys = [
      { user_id: 'user-alice', public_key: alice.publicKey, fingerprint: alice.fingerprint },
      { user_id: 'user-bob', public_key: bob.publicKey, fingerprint: bob.fingerprint },
    ];

    const res = await callGet('res-admin');
    expect(res.status).toBe(200);
    const body = await readDefaults(res);
    expect(body.defaults).toHaveLength(2);
  });

  it('excludes members who have not yet generated a keypair', async () => {
    const alice = await generateUserKeypair();
    fakeState.user = { id: 'user-alice' };
    fakeState.resource = {
      id: 'res-1',
      organization_id: 'org-1',
      is_admin: false,
    };
    fakeState.members = [{ user_id: 'user-alice' }, { user_id: 'user-carol-nokey' }];
    fakeState.keys = [
      { user_id: 'user-alice', public_key: alice.publicKey, fingerprint: alice.fingerprint },
    ];

    const res = await callGet();
    expect(res.status).toBe(200);
    const body = await readDefaults(res);
    expect(body.defaults).toHaveLength(1);
    expect(body.defaults[0]?.user_id).toBe('user-alice');
    expect(body.defaults[0]?.fingerprint).toBe(alice.fingerprint);
  });

  it('accepts bytea hex-escaped public_key (Postgres wire format)', async () => {
    const alice = await generateUserKeypair();
    const hex = `\\x${Buffer.from(alice.publicKey).toString('hex')}`;
    fakeState.user = { id: 'user-alice' };
    fakeState.resource = {
      id: 'res-1',
      organization_id: 'org-1',
      is_admin: false,
    };
    fakeState.members = [{ user_id: 'user-alice' }];
    fakeState.keys = [{ user_id: 'user-alice', public_key: hex, fingerprint: alice.fingerprint }];

    const res = await callGet();
    expect(res.status).toBe(200);
    const body = await readDefaults(res);
    expect(body.defaults).toHaveLength(1);
    expect(
      Buffer.from(body.defaults[0]?.public_key ?? '', 'base64').equals(
        Buffer.from(alice.publicKey),
      ),
    ).toBe(true);
  });
});
