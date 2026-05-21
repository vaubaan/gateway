import { describe, it, expect, beforeEach, vi } from 'vitest';

const TEST_USER_ID = '00000000-0000-0000-0000-000000000001';
const PUBKEY_HEX_32 = '00'.repeat(32);
const SALT_HEX_16 = '11'.repeat(16);
const WRAPPED_HEX_72 = '22'.repeat(72);
const FP_A = 'a'.repeat(32);
const FP_B = 'b'.repeat(32);

const hexToBase64 = (hex: string): string => Buffer.from(hex, 'hex').toString('base64');
const pgBytea = (hex: string): string => `\\x${hex}`;

interface AuditRow {
  readonly organization_id: string | null;
  readonly actor_user_id: string;
  readonly action: string;
  readonly scope: unknown;
  readonly subject: { readonly fingerprint: string; readonly old_fingerprint?: string };
}

interface CryptoRow {
  public_key: string;
  fingerprint: string;
  wrapped_private_key: string;
  kdf_salt: string;
  kdf_params: { m: number; t: number; p: number; alg: 'argon2id' };
  created_at: string;
  rotated_at: string;
}

interface MockState {
  user: { id: string } | null;
  cryptoRow: CryptoRow | null;
  auditRows: AuditRow[];
  insertCryptoError: { code?: string; message: string } | null;
}

const state: MockState = {
  user: null,
  cryptoRow: null,
  auditRows: [],
  insertCryptoError: null,
};

function resetState(): void {
  state.user = { id: TEST_USER_ID };
  state.cryptoRow = null;
  state.auditRows = [];
  state.insertCryptoError = null;
}

interface SelectBuilder {
  eq: (col: string, val: unknown) => SelectBuilder;
  maybeSingle: <T>() => Promise<{ data: T | null; error: null }>;
}

interface UpdateBuilder {
  eq: (col: string, val: unknown) => Promise<{ error: null | { code?: string; message: string } }>;
}

function buildFromTable(table: string): {
  select: (cols: string) => SelectBuilder;
  insert: (
    row: Record<string, unknown>,
  ) => Promise<{ error: null | { code?: string; message: string } }>;
  update: (row: Record<string, unknown>) => UpdateBuilder;
} {
  return {
    select: (_cols: string): SelectBuilder => {
      const builder: SelectBuilder = {
        eq: (_col: string, _val: unknown): SelectBuilder => builder,
        maybeSingle: <T>(): Promise<{ data: T | null; error: null }> => {
          if (table === 'user_crypto_keys') {
            return Promise.resolve({ data: state.cryptoRow as T | null, error: null });
          }
          return Promise.resolve({ data: null, error: null });
        },
      };
      return builder;
    },
    insert: (
      row: Record<string, unknown>,
    ): Promise<{ error: null | { code?: string; message: string } }> => {
      if (table === 'user_crypto_keys') {
        if (state.insertCryptoError) {
          return Promise.resolve({ error: state.insertCryptoError });
        }
        if (state.cryptoRow !== null) {
          return Promise.resolve({ error: { code: '23505', message: 'duplicate key' } });
        }
        state.cryptoRow = {
          public_key: row.public_key as string,
          fingerprint: row.fingerprint as string,
          wrapped_private_key: row.wrapped_private_key as string,
          kdf_salt: row.kdf_salt as string,
          kdf_params: row.kdf_params as CryptoRow['kdf_params'],
          created_at: '2026-05-21T00:00:00Z',
          rotated_at: '2026-05-21T00:00:00Z',
        };
        return Promise.resolve({ error: null });
      }
      if (table === 'audit_log') {
        state.auditRows.push(row as unknown as AuditRow);
        return Promise.resolve({ error: null });
      }
      return Promise.resolve({ error: null });
    },
    update: (row: Record<string, unknown>): UpdateBuilder => ({
      eq: (
        _col: string,
        _val: unknown,
      ): Promise<{ error: null | { code?: string; message: string } }> => {
        if (table === 'user_crypto_keys' && state.cryptoRow !== null) {
          state.cryptoRow = { ...state.cryptoRow, ...(row as Partial<CryptoRow>) };
        }
        return Promise.resolve({ error: null });
      },
    }),
  };
}

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: vi.fn().mockImplementation(() => {
    return Promise.resolve({
      auth: {
        getUser: (): Promise<{ data: { user: { id: string } | null } }> =>
          Promise.resolve({ data: { user: state.user } }),
      },
      from: (table: string) => buildFromTable(table),
    });
  }),
}));

const { GET, POST, PATCH } = await import('../../../src/app/api/crm/v1/me/crypto-key/route');
const { NextRequest } = await import('next/server');

function buildReq(method: 'POST' | 'PATCH', body: unknown): InstanceType<typeof NextRequest> {
  return new NextRequest('http://localhost/api/crm/v1/me/crypto-key', {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const validCreateBody = {
  public_key: hexToBase64(PUBKEY_HEX_32),
  fingerprint: FP_A,
  wrapped_private_key: hexToBase64(WRAPPED_HEX_72),
  kdf_salt: hexToBase64(SALT_HEX_16),
};

describe('GET /api/crm/v1/me/crypto-key', () => {
  beforeEach(resetState);

  it('returns 401 when no session', async () => {
    state.user = null;
    const res = await GET();
    expect(res.status).toBe(401);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('returns 404 when no row exists', async () => {
    const res = await GET();
    expect(res.status).toBe(404);
  });

  it('returns 200 + payload after POST', async () => {
    const postRes = await POST(buildReq('POST', validCreateBody));
    expect(postRes.status).toBe(201);

    const res = await GET();
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.fingerprint).toBe(FP_A);
    expect(json.public_key).toBe(hexToBase64(PUBKEY_HEX_32));
    expect(json.wrapped_private_key).toBe(hexToBase64(WRAPPED_HEX_72));
    expect(json.kdf_salt).toBe(hexToBase64(SALT_HEX_16));
  });
});

describe('POST /api/crm/v1/me/crypto-key', () => {
  beforeEach(resetState);

  it('returns 401 without session', async () => {
    state.user = null;
    const res = await POST(buildReq('POST', validCreateBody));
    expect(res.status).toBe(401);
  });

  it('returns 201 + writes audit row for valid payload', async () => {
    const res = await POST(buildReq('POST', validCreateBody));
    expect(res.status).toBe(201);
    expect(state.cryptoRow?.fingerprint).toBe(FP_A);
    expect(state.cryptoRow?.public_key).toBe(pgBytea(PUBKEY_HEX_32));
    expect(state.auditRows).toHaveLength(1);
    expect(state.auditRows[0]?.action).toBe('user.crypto-key.created');
    expect(state.auditRows[0]?.organization_id).toBeNull();
    expect(state.auditRows[0]?.actor_user_id).toBe(TEST_USER_ID);
    expect(state.auditRows[0]?.subject.fingerprint).toBe(FP_A);
  });

  it('returns 400 on too-weak kdf_params', async () => {
    const res = await POST(
      buildReq('POST', {
        ...validCreateBody,
        kdf_params: { m: 32 * 1024 * 1024, t: 3, p: 1, alg: 'argon2id' },
      }),
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.error).toBe('kdf_params_too_weak');
  });

  it('returns 409 on conflict (row already exists)', async () => {
    const first = await POST(buildReq('POST', validCreateBody));
    expect(first.status).toBe(201);
    const second = await POST(buildReq('POST', validCreateBody));
    expect(second.status).toBe(409);
  });
});

describe('PATCH /api/crm/v1/me/crypto-key', () => {
  beforeEach(resetState);

  it('rotate-password keeps pubkey/fingerprint, updates wrapped_sk + salt, audits', async () => {
    await POST(buildReq('POST', validCreateBody));
    state.auditRows = [];

    const newSalt = hexToBase64('33'.repeat(16));
    const newWrapped = hexToBase64('44'.repeat(72));
    const res = await PATCH(
      buildReq('PATCH', {
        wrapped_private_key: newWrapped,
        kdf_salt: newSalt,
      }),
    );
    expect(res.status).toBe(200);
    expect(state.cryptoRow?.fingerprint).toBe(FP_A);
    expect(state.cryptoRow?.public_key).toBe(pgBytea(PUBKEY_HEX_32));
    expect(state.cryptoRow?.kdf_salt).toBe(pgBytea('33'.repeat(16)));
    expect(state.cryptoRow?.wrapped_private_key).toBe(pgBytea('44'.repeat(72)));
    expect(state.auditRows).toHaveLength(1);
    expect(state.auditRows[0]?.action).toBe('user.crypto-key.rotated-password');
    expect(state.auditRows[0]?.subject.old_fingerprint).toBeUndefined();
  });

  it('replace-identity swaps everything and logs old_fingerprint', async () => {
    await POST(buildReq('POST', validCreateBody));
    state.auditRows = [];

    const res = await PATCH(
      buildReq('PATCH', {
        replace: true,
        public_key: hexToBase64('55'.repeat(32)),
        fingerprint: FP_B,
        wrapped_private_key: hexToBase64('66'.repeat(72)),
        kdf_salt: hexToBase64('77'.repeat(16)),
      }),
    );
    expect(res.status).toBe(200);
    expect(state.cryptoRow?.fingerprint).toBe(FP_B);
    expect(state.cryptoRow?.public_key).toBe(pgBytea('55'.repeat(32)));
    expect(state.auditRows).toHaveLength(1);
    const audit = state.auditRows[0];
    expect(audit?.action).toBe('user.crypto-key.replaced-identity');
    expect(audit?.subject.fingerprint).toBe(FP_B);
    expect(audit?.subject.old_fingerprint).toBe(FP_A);
  });

  it('returns 404 when no row exists to patch', async () => {
    const res = await PATCH(
      buildReq('PATCH', {
        wrapped_private_key: hexToBase64(WRAPPED_HEX_72),
        kdf_salt: hexToBase64(SALT_HEX_16),
      }),
    );
    expect(res.status).toBe(404);
  });

  it('returns 401 without session', async () => {
    state.user = null;
    const res = await PATCH(
      buildReq('PATCH', {
        wrapped_private_key: hexToBase64(WRAPPED_HEX_72),
        kdf_salt: hexToBase64(SALT_HEX_16),
      }),
    );
    expect(res.status).toBe(401);
  });
});

describe('audit log payloads — no cleartext leak', () => {
  beforeEach(resetState);

  it('subject never contains wrapped_private_key / kdf_salt / public_key bytes', async () => {
    await POST(buildReq('POST', validCreateBody));
    await PATCH(
      buildReq('PATCH', {
        replace: true,
        public_key: hexToBase64('55'.repeat(32)),
        fingerprint: FP_B,
        wrapped_private_key: hexToBase64('66'.repeat(72)),
        kdf_salt: hexToBase64('77'.repeat(16)),
      }),
    );
    for (const row of state.auditRows) {
      const subjectJson = JSON.stringify(row.subject);
      expect(subjectJson).not.toContain('22');
      expect(subjectJson).not.toContain('11');
      expect(subjectJson).not.toContain('00');
      const allowedKeys = ['fingerprint', 'old_fingerprint'];
      for (const k of Object.keys(row.subject)) {
        expect(allowedKeys).toContain(k);
      }
    }
  });
});
