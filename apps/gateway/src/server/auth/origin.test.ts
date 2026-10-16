import { describe, expect, it } from 'vitest';

import { forbiddenOriginResponse, isSameOrigin, requestOrigin } from './origin';

const PUBLIC = new URL('https://gateway.example.com');

describe('origin check', () => {
  it('accepts a matching Origin header', () => {
    expect(isSameOrigin(new Headers({ origin: 'https://gateway.example.com' }), PUBLIC)).toBe(true);
  });
  it('refuses another origin, another scheme and the internal host behind the proxy', () => {
    expect(isSameOrigin(new Headers({ origin: 'https://evil.example.net' }), PUBLIC)).toBe(false);
    expect(isSameOrigin(new Headers({ origin: 'http://gateway.example.com' }), PUBLIC)).toBe(false);
    expect(isSameOrigin(new Headers({ origin: 'http://127.0.0.1:3000' }), PUBLIC)).toBe(false);
  });
  it('falls back to the Referer origin when Origin is absent', () => {
    expect(
      isSameOrigin(new Headers({ referer: 'https://gateway.example.com/admin/x?y=1' }), PUBLIC),
    ).toBe(true);
    expect(isSameOrigin(new Headers({ referer: 'https://other.example.com/' }), PUBLIC)).toBe(
      false,
    );
    expect(requestOrigin(new Headers({ referer: 'not a url' }))).toBeNull();
  });
  it('refuses when neither header is present, or Origin is "null"', () => {
    expect(isSameOrigin(new Headers(), PUBLIC)).toBe(false);
    expect(isSameOrigin(new Headers({ origin: 'null' }), PUBLIC)).toBe(false);
  });
  it('answers 403 with a stable error code', async () => {
    const res = forbiddenOriginResponse();
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'origin-mismatch' });
  });
});
