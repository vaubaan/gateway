import { describe, expect, test, vi } from 'vitest';
import type { ProviderAdmin, ProviderBinding } from '@vaubaan/shared';
import { UpstashRedisAdapter } from '../../src/upstash-redis-adapter.ts';

const baseAdmin: ProviderAdmin = {
  id: 'pa-ur',
  organization_id: 'org-1',
  provider: 'upstash-redis',
  status: 'connected',
  installation_id: null,
  team_id: null,
  access_token_encrypted: new TextEncoder().encode('user@example.com:upstash_api_key_123'),
  refresh_token_encrypted: null,
  expires_at: null,
  connected_by_user_id: null,
  connected_at: '2026-01-01T00:00:00Z',
};

const binding: ProviderBinding = {
  id: 'b1',
  project_id: 'p1',
  provider: 'upstash-redis',
  resource_ref: 'db-abc-123',
  display_name: null,
  created_at: '2026-01-01',
};

/** Build a fake JSON response. */
function jsonResponse(payload: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(payload)),
  };
}

describe('UpstashRedisAdapter — mintUpstreamToken', () => {
  test('returns access_token_encrypted as raw credential string', async () => {
    const adapter = new UpstashRedisAdapter();
    const { token } = await adapter.mintUpstreamToken(baseAdmin);
    expect(token).toBe('user@example.com:upstash_api_key_123');
  });

  test('throws when no token', async () => {
    const adapter = new UpstashRedisAdapter();
    await expect(
      adapter.mintUpstreamToken({ ...baseAdmin, access_token_encrypted: null }),
    ).rejects.toThrow(/access_token_encrypted/);
  });
});

describe('UpstashRedisAdapter — executeCall (management tools)', () => {
  test('list_databases GETs /v2/redis/databases with Basic Auth', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) =>
      jsonResponse([{ database_id: 'db-1', database_name: 'my-cache' }]),
    );
    const adapter = new UpstashRedisAdapter({ fetchImpl: fetchImpl as never });
    const out = (await adapter.executeCall(
      baseAdmin,
      binding,
      'upstash_redis__list_databases',
      {},
    )) as Array<{ database_id: string }>;
    expect(out[0]?.database_id).toBe('db-1');
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.upstash.com/v2/redis/databases');
    expect(init.method).toBe('GET');
    // Verify Basic Auth header
    const authHeader = (init.headers as Record<string, string>).Authorization!;
    expect(authHeader).toMatch(/^Basic /);
    const decoded = atob(authHeader.slice('Basic '.length));
    expect(decoded).toBe('user@example.com:upstash_api_key_123');
  });

  test('get_database GETs /v2/redis/database/{id}', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) =>
      jsonResponse({ database_id: 'db-abc-123', database_name: 'my-cache' }),
    );
    const adapter = new UpstashRedisAdapter({ fetchImpl: fetchImpl as never });
    await adapter.executeCall(baseAdmin, binding, 'upstash_redis__get_database', {
      databaseId: 'db-abc-123',
    });
    const [url] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.upstash.com/v2/redis/database/db-abc-123');
  });

  test('create_database POSTs /v2/redis/database with body', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) =>
      jsonResponse({ database_id: 'new-db', database_name: 'test-db' }),
    );
    const adapter = new UpstashRedisAdapter({ fetchImpl: fetchImpl as never });
    await adapter.executeCall(baseAdmin, binding, 'upstash_redis__create_database', {
      name: 'test-db',
      region: 'us-east-1',
      tls: true,
    });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.upstash.com/v2/redis/database');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.name).toBe('test-db');
    expect(body.region).toBe('us-east-1');
    expect(body.tls).toBe(true);
  });

  test('delete_database DELETEs /v2/redis/database/{id}', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => jsonResponse('OK'));
    const adapter = new UpstashRedisAdapter({ fetchImpl: fetchImpl as never });
    await adapter.executeCall(baseAdmin, binding, 'upstash_redis__delete_database', {
      databaseId: 'db-abc-123',
    });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.upstash.com/v2/redis/database/db-abc-123');
    expect(init.method).toBe('DELETE');
  });

  test('rename_database POSTs /v2/redis/rename/{id}', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) =>
      jsonResponse({ database_name: 'new-name' }),
    );
    const adapter = new UpstashRedisAdapter({ fetchImpl: fetchImpl as never });
    await adapter.executeCall(baseAdmin, binding, 'upstash_redis__rename_database', {
      databaseId: 'db-abc-123',
      name: 'new-name',
    });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.upstash.com/v2/redis/rename/db-abc-123');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.name).toBe('new-name');
  });

  test('surfaces HTTP errors from Management API', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve('Unauthorized'),
    });
    const adapter = new UpstashRedisAdapter({ fetchImpl: fetchImpl as never });
    await expect(
      adapter.executeCall(baseAdmin, binding, 'upstash_redis__list_databases', {}),
    ).rejects.toThrow(/401/);
  });
});

describe('UpstashRedisAdapter — executeCall (data tools)', () => {
  test('get fetches database connection then calls Data API', async () => {
    let callCount = 0;
    const fetchImpl = vi.fn(async (url: string, _init: RequestInit) => {
      callCount++;
      // First call: Management API to get database details
      if (callCount === 1) {
        expect(url).toBe('https://api.upstash.com/v2/redis/database/db-abc-123');
        return jsonResponse({
          database_id: 'db-abc-123',
          rest_url: 'https://us1-my-db.upstash.io',
          rest_token: 'AXxxRest_Token_123',
        });
      }
      // Second call: Data API
      expect(url).toBe('https://us1-my-db.upstash.io');
      return jsonResponse({ result: 'hello' });
    });
    const adapter = new UpstashRedisAdapter({ fetchImpl: fetchImpl as never });
    const out = await adapter.executeCall(baseAdmin, binding, 'upstash_redis__get', {
      key: 'mykey',
    });
    expect(out).toEqual({ result: 'hello' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    // Verify Data API call used Bearer auth and correct command
    const [, init] = fetchImpl.mock.calls[1] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer AXxxRest_Token_123',
    );
    const body = JSON.parse(init.body as string) as string[];
    expect(body).toEqual(['GET', 'mykey']);
  });

  test('set builds correct Redis command with TTL options', async () => {
    let dataApiBody: string[] | null = null;
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      if (url.includes('api.upstash.com')) {
        return jsonResponse({
          rest_url: 'https://us1-db.upstash.io',
          rest_token: 'tok',
        });
      }
      dataApiBody = JSON.parse(init.body as string) as string[];
      return jsonResponse({ result: 'OK' });
    });
    const adapter = new UpstashRedisAdapter({ fetchImpl: fetchImpl as never });
    await adapter.executeCall(baseAdmin, binding, 'upstash_redis__set', {
      key: 'session:123',
      value: 'data',
      ex: 3600,
      nx: true,
    });
    expect(dataApiBody).toEqual(['SET', 'session:123', 'data', 'EX', '3600', 'NX']);
  });

  test('del builds correct DEL command', async () => {
    let dataApiBody: string[] | null = null;
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      if (url.includes('api.upstash.com')) {
        return jsonResponse({
          rest_url: 'https://us1-db.upstash.io',
          rest_token: 'tok',
        });
      }
      dataApiBody = JSON.parse(init.body as string) as string[];
      return jsonResponse({ result: 2 });
    });
    const adapter = new UpstashRedisAdapter({ fetchImpl: fetchImpl as never });
    await adapter.executeCall(baseAdmin, binding, 'upstash_redis__del', {
      keys: ['key1', 'key2'],
    });
    expect(dataApiBody).toEqual(['DEL', 'key1', 'key2']);
  });

  test('hset builds correct HSET command with field-value pairs', async () => {
    let dataApiBody: string[] | null = null;
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      if (url.includes('api.upstash.com')) {
        return jsonResponse({
          rest_url: 'https://us1-db.upstash.io',
          rest_token: 'tok',
        });
      }
      dataApiBody = JSON.parse(init.body as string) as string[];
      return jsonResponse({ result: 2 });
    });
    const adapter = new UpstashRedisAdapter({ fetchImpl: fetchImpl as never });
    await adapter.executeCall(baseAdmin, binding, 'upstash_redis__hset', {
      key: 'user:1',
      fields: { name: 'Alice', age: '30' },
    });
    expect(dataApiBody).toContain('HSET');
    expect(dataApiBody).toContain('user:1');
    expect(dataApiBody).toContain('name');
    expect(dataApiBody).toContain('Alice');
  });

  test('execute builds raw command from array', async () => {
    let dataApiBody: string[] | null = null;
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      if (url.includes('api.upstash.com')) {
        return jsonResponse({
          rest_url: 'https://us1-db.upstash.io',
          rest_token: 'tok',
        });
      }
      dataApiBody = JSON.parse(init.body as string) as string[];
      return jsonResponse({ result: 'PONG' });
    });
    const adapter = new UpstashRedisAdapter({ fetchImpl: fetchImpl as never });
    await adapter.executeCall(baseAdmin, binding, 'upstash_redis__execute', {
      command: ['PING'],
    });
    expect(dataApiBody).toEqual(['PING']);
  });

  test('all tools exposed in availableTools', () => {
    const adapter = new UpstashRedisAdapter();
    const names = adapter.availableTools.map((t) => t.name);
    // Management tools
    expect(names).toContain('upstash_redis__list_databases');
    expect(names).toContain('upstash_redis__get_database');
    expect(names).toContain('upstash_redis__create_database');
    expect(names).toContain('upstash_redis__delete_database');
    expect(names).toContain('upstash_redis__rename_database');
    expect(names).toContain('upstash_redis__get_database_stats');
    // Data tools
    expect(names).toContain('upstash_redis__execute');
    expect(names).toContain('upstash_redis__get');
    expect(names).toContain('upstash_redis__set');
    expect(names).toContain('upstash_redis__del');
    expect(names).toContain('upstash_redis__keys');
    expect(names).toContain('upstash_redis__scan');
    expect(names).toContain('upstash_redis__ttl');
    expect(names).toContain('upstash_redis__expire');
    expect(names).toContain('upstash_redis__hset');
    expect(names).toContain('upstash_redis__hgetall');
    expect(names).toContain('upstash_redis__lpush');
    expect(names).toContain('upstash_redis__lrange');
    expect(names).toContain('upstash_redis__sadd');
    expect(names).toContain('upstash_redis__smembers');
    expect(names).toContain('upstash_redis__dbsize');
    expect(names).toHaveLength(21);
  });
});

describe('UpstashRedisAdapter — validateBinding', () => {
  test('validates by fetching database details', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) =>
      jsonResponse({ database_id: 'db-abc-123', database_name: 'my-cache' }),
    );
    const adapter = new UpstashRedisAdapter({ fetchImpl: fetchImpl as never });
    const result = await adapter.validateBinding(baseAdmin, 'db-abc-123');
    expect(result.ok).toBe(true);
    expect(result.displayName).toBe('my-cache');
  });

  test('returns error when database not found', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: () => Promise.resolve('Not Found'),
    });
    const adapter = new UpstashRedisAdapter({ fetchImpl: fetchImpl as never });
    const result = await adapter.validateBinding(baseAdmin, 'db-nonexistent');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/validation failed/i);
  });
});
