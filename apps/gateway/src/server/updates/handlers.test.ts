import { describe, expect, it, vi } from 'vitest';

import type { Authenticator, Principal } from '../auth/authenticator';
import { createUpdatesHandlers, PLUGINS_PAGE, UPDATES_CHECK_ACTION } from './handlers';

const PUBLIC_URL = new URL('https://gateway.example.com');
const OPERATOR = { kind: 'user', id: 'user-ops', isOperator: true } as unknown as Principal;

type GuardAuthenticator = Pick<Authenticator, 'authenticate' | 'authorizeAdmin'>;

function authenticator(operator: boolean): GuardAuthenticator {
  return {
    authenticate: async () => OPERATOR,
    authorizeAdmin: (async () =>
      operator
        ? { ok: true, principal: OPERATOR }
        : { ok: false, status: 404 }) as unknown as GuardAuthenticator['authorizeAdmin'],
  };
}

function post(origin = PUBLIC_URL.origin): Request {
  return new Request(new URL(UPDATES_CHECK_ACTION, PUBLIC_URL), {
    method: 'POST',
    headers: { origin, 'sec-fetch-mode': 'navigate' },
  });
}

describe('"Check now" on Administration › Plugins', () => {
  it('reads the feed for an administrator and goes back to the page', async () => {
    const refresh = vi.fn(async () => null);
    const handlers = createUpdatesHandlers({
      publicUrl: PUBLIC_URL,
      authenticator: authenticator(true),
      updates: { refresh },
    });
    const response = await handlers.checkNow(post());
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(PLUGINS_PAGE);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('reads nothing for someone who does not administer, or from another origin', async () => {
    const refresh = vi.fn(async () => null);
    const refused = createUpdatesHandlers({
      publicUrl: PUBLIC_URL,
      authenticator: authenticator(false),
      updates: { refresh },
    });
    expect((await refused.checkNow(post())).status).toBe(403);
    const operator = createUpdatesHandlers({
      publicUrl: PUBLIC_URL,
      authenticator: authenticator(true),
      updates: { refresh },
    });
    expect((await operator.checkNow(post('https://elsewhere.example.com'))).status).toBe(403);
    expect(refresh).not.toHaveBeenCalled();
  });
});
