import { describe, expect, it } from 'vitest';

import {
  effectiveState,
  isDecidable,
  isTerminal,
  nextState,
  type RequestTransition,
} from './state';
import { inboxRequestPath, requestPath, requestUrl, requestUrlBuilder } from './url';

const TRANSITIONS: readonly RequestTransition[] = ['grant', 'refuse', 'expire'];

describe('request state machine (spec §2.3)', () => {
  it('an open request is granted, refused or expired', () => {
    expect(nextState('open', 'grant')).toBe('granted');
    expect(nextState('open', 'refuse')).toBe('refused');
    expect(nextState('open', 'expire')).toBe('expired');
  });

  it.each(['granted', 'refused', 'expired'] as const)('%s is terminal', (state) => {
    expect(isTerminal(state)).toBe(true);
    for (const transition of TRANSITIONS) expect(nextState(state, transition)).toBeNull();
  });

  it('open is not terminal', () => {
    expect(isTerminal('open')).toBe(false);
  });

  it('an open request past its expiry reads expired before the sweeper flips it', () => {
    const request = { state: 'open', expiresAt: '2026-10-14T09:00:00.000Z' } as const;
    expect(effectiveState(request, new Date('2026-10-14T08:59:59.999Z'))).toBe('open');
    expect(isDecidable(request, new Date('2026-10-14T08:59:59.999Z'))).toBe(true);
    // The boundary instant is already expired, as in the store's `expires_at <= now`.
    expect(effectiveState(request, new Date('2026-10-14T09:00:00.000Z'))).toBe('expired');
    expect(isDecidable(request, new Date('2026-10-15T00:00:00.000Z'))).toBe(false);
  });

  it('a decided request keeps its state whatever the clock says', () => {
    const late = new Date('2027-01-01T00:00:00.000Z');
    for (const state of ['granted', 'refused', 'expired'] as const) {
      expect(effectiveState({ state, expiresAt: '2026-10-14T09:00:00.000Z' }, late)).toBe(state);
      expect(isDecidable({ state, expiresAt: '2027-06-01T00:00:00.000Z' }, late)).toBe(false);
    }
  });
});

describe('request URL', () => {
  const publicUrl = new URL('https://gateway.example.com');

  it('is <public_url>/r/<id>, from the origin only', () => {
    expect(requestUrl(publicUrl, 'abc')).toBe('https://gateway.example.com/r/abc');
    expect(requestUrl(new URL('https://gateway.example.com/ignored?x=1'), 'abc')).toBe(
      'https://gateway.example.com/r/abc',
    );
    expect(requestUrlBuilder(publicUrl)('abc')).toBe(requestUrl(publicUrl, 'abc'));
  });

  it('encodes the id: a crafted id cannot leave the prefix', () => {
    expect(requestPath('../admin')).toBe('/r/..%2Fadmin');
    expect(inboxRequestPath('a b')).toBe('/waiting/a%20b');
  });
});
