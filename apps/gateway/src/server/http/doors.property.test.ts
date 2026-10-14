/**
 * Property-based tests of what the doors read from a request before anything
 * is authenticated: the `Authorization` header (MCP doors and git door), the
 * agent label (`_meta.agent` / header), `X-Forwarded-For`, and the git door's
 * request path. Any client on the network writes these, so each reader is fed
 * arbitrary strings.
 *
 * Properties: no reader throws anything but its own typed error, and what it
 * returns is bounded by what it was given (a bearer is a substring of the
 * header, a client address is a hop of the header and never a trusted proxy).
 * Seeded and replayable (`propertyRuns`, FC_SEED / FC_RUNS).
 */
import { isIP } from 'node:net';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { AuthError, parseBearer } from '@vaubaan/gateway-core';
import { propertyRuns } from '@vaubaan/plugin-sdk/testing';

import { parseAgentLabel } from '../execution/request-meta';
import { bearerOf } from '../git/door';
import { parseGitPath } from '../git/paths';
import { AGENT_LABEL_MAX_LENGTH } from '../missions/bootstrap-kit';
import { clientIpResolver, UNKNOWN_CLIENT } from './client-ip';

const anyText = fc.oneof(
  fc.string({ maxLength: 120 }),
  fc.string({ unit: 'binary', maxLength: 60 }),
  fc
    .array(fc.constantFrom('Bearer', 'bearer', 'Basic', ' ', '\t', ':', '=', 'vbn_live_', 'x'), {
      maxLength: 12,
    })
    .map((p) => p.join('')),
);
/** A token as a client sends it: printable, no whitespace. */
const token = fc.stringMatching(/^[A-Za-z0-9._~+/=-]{1,80}$/);

describe('Authorization header — properties', () => {
  it('parseBearer returns a non-empty part of the header or throws AuthError, nothing else', () => {
    fc.assert(
      fc.property(anyText, (header) => {
        try {
          const bearer = parseBearer(header);
          expect(bearer.length).toBeGreaterThan(0);
          expect(header).toContain(bearer);
        } catch (err) {
          expect(err).toBeInstanceOf(AuthError);
        }
      }),
      propertyRuns(),
    );
  });

  it('parseBearer reads back the token of `Bearer <token>`, whatever the scheme case', () => {
    fc.assert(
      fc.property(token, fc.constantFrom('Bearer', 'bearer', 'BEARER'), (t, scheme) => {
        expect(parseBearer(`${scheme} ${t}`)).toBe(t);
      }),
      propertyRuns(),
    );
  });

  it('the git door never throws, and reads the password of Basic or the token of Bearer', () => {
    fc.assert(
      fc.property(anyText, (header) => {
        const read = bearerOf(header);
        if (read !== null) expect(read.length).toBeGreaterThan(0);
      }),
      propertyRuns(),
    );
    fc.assert(
      fc.property(fc.string({ maxLength: 20 }), token, (user, key) => {
        const basic = Buffer.from(`${user.replace(/:/g, '')}:${key}`, 'utf8').toString('base64');
        expect(bearerOf(`Basic ${basic}`)).toBe(key);
        expect(bearerOf(`Bearer ${key}`)).toBe(key);
      }),
      propertyRuns(),
    );
  });
});

describe('agent label — properties', () => {
  it('a label is trimmed, bounded and of the documented shape; a refusal never carries the value', () => {
    fc.assert(
      fc.property(fc.oneof(anyText, fc.anything()), (raw) => {
        const parsed = parseAgentLabel(raw);
        if (parsed.kind === 'label') {
          expect(parsed.label).toBe(parsed.label.trim());
          expect(parsed.label.length).toBeLessThanOrEqual(AGENT_LABEL_MAX_LENGTH);
          expect(parsed.label).toMatch(/^[A-Za-z0-9]/);
        }
        if (parsed.kind === 'rejected')
          expect(Object.keys(parsed).sort()).toEqual(['kind', 'length', 'reason']);
      }),
      propertyRuns(),
    );
  });
});

describe('X-Forwarded-For — properties', () => {
  const trusted = ['10.0.0.0/8', '192.168.1.1', 'fd00::/8'];
  const clientIp = clientIpResolver(trusted);
  const hop = fc.oneof(
    fc.ipV4(),
    fc.ipV6(),
    fc.constantFrom(
      '10.1.2.3',
      '192.168.1.1',
      'fd00::1',
      'unknown',
      '',
      ' ',
      '[::1]:443',
      '1.2.3.4:80',
    ),
    fc.string({ maxLength: 20 }),
  );

  it('the client is unknown or a hop of the header, never a trusted proxy', () => {
    fc.assert(
      fc.property(fc.array(hop, { maxLength: 8 }), (hops) => {
        const header = hops.join(', ');
        const ip = clientIp(new Headers({ 'x-forwarded-for': header }));
        if (ip === UNKNOWN_CLIENT) return;
        expect(isIP(ip)).not.toBe(0);
        expect(header).toContain(ip);
        expect(['10.1.2.3', '192.168.1.1', 'fd00::1']).not.toContain(ip);
      }),
      propertyRuns(),
    );
  });

  it('a header that is not even a list never throws', () => {
    fc.assert(
      fc.property(anyText, (header) => {
        let headers: Headers;
        try {
          headers = new Headers({ 'x-forwarded-for': header });
        } catch {
          return; // not a valid header value: the HTTP layer refuses it first
        }
        clientIp(headers);
      }),
      propertyRuns(),
    );
  });
});

describe('git door path — properties', () => {
  it('any request path is cut or ignored, never thrown on', () => {
    const segment = fc.oneof(
      fc.constantFrom(
        'git',
        'info',
        'refs',
        'lfs',
        'git-upload-pack',
        'git-receive-pack',
        '..',
        '.',
        '',
        'x.git',
      ),
      fc.string({ maxLength: 12 }),
    );
    fc.assert(
      fc.property(
        fc.array(segment, { maxLength: 8 }),
        fc.string({ maxLength: 20 }),
        (segments, query) => {
          const url = new URL('https://gateway.example.com');
          url.pathname = `/${segments.join('/')}`;
          url.searchParams.set('service', query);
          const path = parseGitPath(url);
          if (path !== null) expect(typeof path.repositoryPath).toBe('string');
        },
      ),
      propertyRuns(),
    );
  });
});
