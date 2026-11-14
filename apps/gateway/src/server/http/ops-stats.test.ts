import { describe, expect, it } from 'vitest';

import type { OpsStats } from '../limits';
import { silentLogger } from '../logging/logger';
import {
  opsStatsResponse,
  opsStatsSetupResponse,
  opsStatsUnavailableResponse,
  presentsOpsToken,
} from './ops-stats';

const TOKEN = 'ops-token-of-at-least-thirty-two-characters';
const URL_ = 'https://gateway.example.com/ops/stats';

const STATS: OpsStats = {
  generated_at: '2026-10-31T15:30:00.000Z',
  users: 3,
  accounts: { total: 1, by_provider: { github: 1 } },
  active_missions: 1,
  calls_today: { since: '2026-10-31T00:00:00.000Z', allowed: 2, refused: 0 },
  store: { kind: 'memory', bytes: 4096 },
  keys: { current_version: 1, sealed_by_version: { '1': 1 } },
  limits: { users: null, accounts: null, active_missions: null },
};

function request(authorization?: string): Request {
  return new Request(URL_, {
    headers: authorization === undefined ? {} : { authorization },
  });
}

const deps = (token: string | null, collect = async () => STATS) => ({
  token,
  collect,
  logger: silentLogger,
});

describe('GET /ops/stats', () => {
  it('does not exist without ops.token: 404, whatever is presented', async () => {
    for (const auth of [undefined, `Bearer ${TOKEN}`]) {
      const res = await opsStatsResponse(request(auth), deps(null));
      expect(res.status).toBe(404);
      expect(await res.text()).toBe('');
    }
  });

  it.each([
    ['no Authorization header', undefined],
    ['an empty bearer', 'Bearer '],
    ['another scheme', `Basic ${TOKEN}`],
    ['a wrong token', 'Bearer ops-token-of-at-least-thirty-two-characterz'],
    ['a prefix of the token', `Bearer ${TOKEN.slice(0, 10)}`],
    ['the token with more after it', `Bearer ${TOKEN}x`],
  ])('refuses %s with 401 and says nothing more', async (_label, auth) => {
    let collected = false;
    const res = await opsStatsResponse(
      request(auth),
      deps(TOKEN, async () => {
        collected = true;
        return STATS;
      }),
    );
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.text()).toBe('');
    expect(collected).toBe(false);
  });

  it('answers the counts to the bearer of the token, never cached', async () => {
    const res = await opsStatsResponse(request(`Bearer ${TOKEN}`), deps(TOKEN));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(await res.json()).toEqual(STATS);
    // The scheme is case-insensitive (RFC 9110 §11.1).
    expect(presentsOpsToken(new Headers({ authorization: `bearer ${TOKEN}` }), TOKEN)).toBe(true);
  });

  it('answers 503 without detail when the counts cannot be read', async () => {
    const res = await opsStatsResponse(
      request(`Bearer ${TOKEN}`),
      deps(TOKEN, async () => {
        throw new Error('SQLITE_BUSY: /data/gateway.db');
      }),
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: 'unavailable' });
    expect(opsStatsUnavailableResponse().status).toBe(503);
  });

  it('in setup mode: 404 without a token, 401 with a wrong one, else 503 setup', async () => {
    expect(opsStatsSetupResponse(request(`Bearer ${TOKEN}`), null).status).toBe(404);
    expect(opsStatsSetupResponse(request('Bearer nope'), TOKEN).status).toBe(401);
    const res = opsStatsSetupResponse(request(`Bearer ${TOKEN}`), TOKEN);
    expect(res.status).toBe(503);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ status: 'setup' });
  });
});
