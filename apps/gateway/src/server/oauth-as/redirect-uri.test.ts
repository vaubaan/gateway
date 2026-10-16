import { describe, expect, it } from 'vitest';

import {
  checkRedirectUri,
  isLoopbackHost,
  isLoopbackOnly,
  matchesRegisteredRedirect,
  MAX_REDIRECT_URI_LENGTH,
  redirectDestination,
} from './redirect-uri';

const kindOf = (uri: unknown): string => {
  const check = checkRedirectUri(uri);
  return check.ok ? check.kind : `refused: ${check.reason}`;
};

describe('redirect URIs a client may register', () => {
  it.each([
    ['http://127.0.0.1/callback', 'loopback'],
    ['http://127.0.0.1:43210/callback', 'loopback'],
    ['http://127.8.9.10:8080/cb', 'loopback'],
    ['http://[::1]:9000/cb', 'loopback'],
    ['http://localhost:3000/oauth/callback', 'loopback'],
    ['https://localhost/cb', 'loopback'],
    ['https://agent.example.net/oauth/callback', 'web'],
    ['https://agent.example.net/cb?tenant=acme', 'web'],
    ['cursor://anysphere.cursor-retrieval/oauth/callback', 'app-scheme'],
    ['com.example.agent:/oauth/callback', 'app-scheme'],
  ])('classifies %s as %s', (uri, kind) => {
    expect(kindOf(uri)).toBe(kind);
  });

  it.each([
    ['plain http to a host on the network', 'http://agent.example.net/cb'],
    ['a host that only starts like the loopback', 'http://127.0.0.1.example.net/cb'],
    ['a host that only starts like localhost', 'http://localhost.example.net/cb'],
    ['a fragment', 'https://agent.example.net/cb#token'],
    ['an empty fragment', 'https://agent.example.net/cb#'],
    ['credentials', 'https://user:pass@agent.example.net/cb'],
    ['a relative reference', '/oauth/callback'],
    ['a scheme-relative reference', '//agent.example.net/cb'],
    ['a javascript URI', 'javascript:alert(1)'],
    ['a data URI', 'data:text/html,<script>alert(1)</script>'],
    ['a file URI', 'file:///etc/passwd'],
    ['a websocket', 'wss://agent.example.net/cb'],
    ['a browser extension page', 'chrome-extension://abcdef/cb.html'],
    ['a space', 'https://agent.example.net/c b'],
    ['a tab', 'https://agent.example.net/c\tb'],
    ['a line break', 'https://agent.example.net/cb\nLocation: https://evil.example'],
    ['a backslash', 'https://agent.example.net\\@evil.example/cb'],
    ['nothing', ''],
  ])('refuses %s', (_case, uri) => {
    expect(checkRedirectUri(uri).ok).toBe(false);
  });

  it('refuses anything that is not a string, and an oversized one', () => {
    for (const value of [null, undefined, 42, ['https://agent.example.net/cb'], {}]) {
      expect(checkRedirectUri(value).ok).toBe(false);
    }
    const long = `https://agent.example.net/${'a'.repeat(MAX_REDIRECT_URI_LENGTH)}`;
    expect(checkRedirectUri(long).ok).toBe(false);
  });

  it('knows the loopback interface in its written forms, and nothing else', () => {
    for (const host of ['127.0.0.1', '127.255.255.254', 'localhost', 'LOCALHOST', '[::1]']) {
      expect(isLoopbackHost(host)).toBe(true);
    }
    for (const host of ['128.0.0.1', '127.0.0.1.example.net', '10.0.0.1', '[::2]', '0.0.0.0']) {
      expect(isLoopbackHost(host)).toBe(false);
    }
  });

  it('judges the loopback interface by the host a browser would reach, whatever the notation', () => {
    // The URL parser normalises these to 127.0.0.1: they are the loopback, and say so.
    expect(kindOf('http://2130706433/cb')).toBe('loopback');
    expect(kindOf('http://127.1/cb')).toBe('loopback');
    // …and these to a host on the network: http is refused.
    expect(checkRedirectUri('http://3232235777/cb').ok).toBe(false);
  });

  it('calls a client loopback-only when every URI is on the loopback interface', () => {
    expect(isLoopbackOnly(['http://127.0.0.1/cb', 'http://localhost:1234/cb'])).toBe(true);
    expect(isLoopbackOnly(['http://127.0.0.1/cb', 'https://agent.example.net/cb'])).toBe(false);
    expect(isLoopbackOnly(['cursor://x/cb'])).toBe(false);
    expect(isLoopbackOnly(['not a uri'])).toBe(false);
    expect(isLoopbackOnly([])).toBe(false);
  });
});

describe('the redirect URI of an authorization request', () => {
  const web = ['https://agent.example.net/oauth/callback'];

  it('matches a registered URI exactly', () => {
    expect(matchesRegisteredRedirect(web, 'https://agent.example.net/oauth/callback')).toBe(true);
  });

  it.each([
    ['a longer path', 'https://agent.example.net/oauth/callback/extra'],
    ['a shorter path', 'https://agent.example.net/oauth'],
    ['a trailing slash', 'https://agent.example.net/oauth/callback/'],
    ['an added query', 'https://agent.example.net/oauth/callback?next=https://evil.example'],
    ['another host', 'https://evil.example/oauth/callback'],
    ['a sub-domain', 'https://x.agent.example.net/oauth/callback'],
    ['a host suffix', 'https://agent.example.net.evil.example/oauth/callback'],
    ['another port', 'https://agent.example.net:8443/oauth/callback'],
    ['another scheme', 'http://agent.example.net/oauth/callback'],
    ['a different case', 'https://agent.example.net/OAuth/callback'],
    ['a dot segment', 'https://agent.example.net/oauth/../oauth/callback'],
    ['an encoded character', 'https://agent.example.net/oauth/c%61llback'],
    ['credentials', 'https://agent.example.net@evil.example/oauth/callback'],
  ])('refuses %s on a web URI', (_case, presented) => {
    expect(matchesRegisteredRedirect(web, presented)).toBe(false);
  });

  it('lets a loopback URI differ from the registered one by its port alone', () => {
    const registered = ['http://127.0.0.1/callback'];
    expect(matchesRegisteredRedirect(registered, 'http://127.0.0.1:51234/callback')).toBe(true);
    expect(matchesRegisteredRedirect(registered, 'http://127.0.0.1/callback')).toBe(true);
    expect(matchesRegisteredRedirect(registered, 'http://127.0.0.1:51234/other')).toBe(false);
    expect(matchesRegisteredRedirect(registered, 'http://127.0.0.1:51234/callback?x=1')).toBe(
      false,
    );
    // Another loopback name is another URI: the port is the only freedom.
    expect(matchesRegisteredRedirect(registered, 'http://localhost:51234/callback')).toBe(false);
    expect(matchesRegisteredRedirect(registered, 'https://127.0.0.1:51234/callback')).toBe(false);
  });

  it('never extends the port freedom beyond the loopback interface', () => {
    expect(
      matchesRegisteredRedirect(['http://127.0.0.1/callback'], 'http://10.0.0.5:51234/callback'),
    ).toBe(false);
    expect(
      matchesRegisteredRedirect(['cursor://agent/callback'], 'cursor://agent:1234/callback'),
    ).toBe(false);
  });

  it('matches nothing against an empty registration', () => {
    expect(matchesRegisteredRedirect([], 'http://127.0.0.1/callback')).toBe(false);
  });
});

describe('where the code goes, as the consent screen names it', () => {
  it('names the host and port of an http(s) URI', () => {
    expect(redirectDestination('http://127.0.0.1:43210/callback')).toEqual({
      kind: 'loopback',
      label: '127.0.0.1:43210',
    });
    expect(redirectDestination('https://agent.example.net/cb')).toEqual({
      kind: 'web',
      label: 'agent.example.net',
    });
  });

  it('names the scheme of an application URI', () => {
    expect(redirectDestination('cursor://agent/callback')).toEqual({
      kind: 'app-scheme',
      label: 'cursor://',
    });
  });

  it('names nothing for a URI that could not be registered', () => {
    expect(redirectDestination('javascript:alert(1)')).toBeNull();
  });
});
