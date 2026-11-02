import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  contentSecurityPolicy,
  ownsItsPolicy,
  publishedHttps,
  publishHttps,
  securityHeaders,
} from './security-headers';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');

function directives(csp: string): Map<string, string> {
  return new Map(
    csp.split(';').map((d) => {
      const [name = '', ...values] = d.trim().split(/\s+/);
      return [name, values.join(' ')] as const;
    }),
  );
}

describe('security headers set by the application', () => {
  it('sends every header, HSTS only for an https public URL', () => {
    const https = securityHeaders({ https: true, nonce: 'abc' });
    expect(https).toMatchObject({
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'Strict-Transport-Security': 'max-age=31536000',
    });
    expect(https['Permissions-Policy']).toContain('camera=()');
    expect(securityHeaders({ https: false, nonce: 'abc' })).not.toHaveProperty(
      'Strict-Transport-Security',
    );
  });

  it('admits only the nonce’s scripts and forbids framing — stricter than framing alone', () => {
    const csp = directives(contentSecurityPolicy('n0nce'));
    expect(csp.get('script-src')).toBe("'self' 'nonce-n0nce' 'strict-dynamic'");
    expect(csp.get('frame-ancestors')).toBe("'none'");
    expect(csp.get('default-src')).toBe("'self'");
    expect(csp.get('object-src')).toBe("'none'");
    expect(csp.get('base-uri')).toBe("'none'");
    expect(csp.get('script-src')).not.toContain('unsafe-inline');
    expect(csp.get('script-src')).not.toContain('unsafe-eval');
    expect(directives(contentSecurityPolicy('n', true)).get('script-src')).toContain(
      "'unsafe-eval'",
    );
  });

  it('admits the service worker and the manifest of the instance, from its own origin only', () => {
    // `'strict-dynamic'` drops `'self'` from `script-src`: a worker falling back to it
    // would be blocked, so `worker-src` must say `'self'` on its own (spec §4.2 bis).
    const csp = directives(contentSecurityPolicy('n0nce'));
    expect(csp.get('worker-src')).toBe("'self'");
    expect(csp.get('manifest-src')).toBe("'self'");
  });

  it('leaves the OAuth consent documents to their own, stricter policy', () => {
    expect(ownsItsPolicy('/oauth/authorize')).toBe(true);
    expect(ownsItsPolicy('/oauth/authorize/decision')).toBe(true);
    expect(ownsItsPolicy('/oauth/authorizer')).toBe(false);
    expect(ownsItsPolicy('/login')).toBe(false);
  });

  it('carries the https flag the root publishes', () => {
    publishHttps(true);
    expect(publishedHttps()).toBe(true);
    publishHttps(false);
    expect(publishedHttps()).toBe(false);
  });
});

describe('structural: one source for the security headers', () => {
  function walk(path: string, out: string[]): void {
    const stat = statSync(path);
    if (stat.isFile()) {
      out.push(path);
      return;
    }
    for (const entry of readdirSync(path)) {
      if (entry === 'node_modules' || entry === '.next') continue;
      walk(join(path, entry), out);
    }
  }

  it('only this module and the OAuth documents write a Content-Security-Policy', () => {
    const files: string[] = [];
    walk(resolve(REPO, 'apps/gateway/src'), files);
    const writers = files
      .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f))
      .filter((f) => /'Content-Security-Policy'/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(REPO, f))
      .sort();
    expect(writers).toEqual([
      'apps/gateway/src/proxy.ts',
      'apps/gateway/src/server/http/security-headers.ts',
      'apps/gateway/src/server/oauth-as/pages.ts',
    ]);
  });

  it('the reference proxy sets none of the headers the application owns', () => {
    const caddyfile = readFileSync(resolve(REPO, 'deploy/caddy/Caddyfile'), 'utf8')
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n');
    for (const name of Object.keys(securityHeaders({ https: true, nonce: 'x' }))) {
      expect(caddyfile, name).not.toContain(name);
    }
  });

  it('the reference proxy compresses the static assets only, never a page (BREACH)', () => {
    const directives = readFileSync(resolve(REPO, 'deploy/caddy/Caddyfile'), 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'));
    expect(directives.filter((line) => line.startsWith('encode'))).toEqual([
      'encode @static zstd gzip',
    ]);
    expect(directives).toContain('@static path /_next/static/*');
  });
});
