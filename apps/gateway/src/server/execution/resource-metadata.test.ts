import { describe, expect, it } from 'vitest';

import { executionResourceMetadata, executionResourceMetadataResponse } from './resource-metadata';

const PUBLIC_URL = new URL('https://gateway.example.com/');

describe('RFC 9728 metadata of the execution door', () => {
  it('names the door and no authorization server', () => {
    expect(executionResourceMetadata(PUBLIC_URL)).toEqual({
      resource: 'https://gateway.example.com/mcp',
      authorization_servers: [],
      bearer_methods_supported: ['header'],
    });
    // A sub-path is kept, a trailing slash is not doubled.
    expect(
      executionResourceMetadata(new URL('https://intranet.example.com/gateway/')).resource,
    ).toBe('https://intranet.example.com/gateway/mcp');
  });

  it('answers GET and HEAD from any origin, the preflight, and refuses the rest', async () => {
    const get = executionResourceMetadataResponse(
      PUBLIC_URL,
      new Request('https://gateway.example.com/.well-known/oauth-protected-resource'),
    );
    expect(get.status).toBe(200);
    expect(get.headers.get('access-control-allow-origin')).toBe('*');
    expect(get.headers.get('cache-control')).toBe('no-store');
    expect(await get.json()).toMatchObject({ authorization_servers: [] });

    const head = executionResourceMetadataResponse(
      PUBLIC_URL,
      new Request('https://gateway.example.com/.well-known/oauth-protected-resource', {
        method: 'HEAD',
      }),
    );
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');

    const preflight = executionResourceMetadataResponse(
      PUBLIC_URL,
      new Request('https://gateway.example.com/.well-known/oauth-protected-resource', {
        method: 'OPTIONS',
      }),
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-methods')).toBe('GET, HEAD, OPTIONS');

    const post = executionResourceMetadataResponse(
      PUBLIC_URL,
      new Request('https://gateway.example.com/.well-known/oauth-protected-resource', {
        method: 'POST',
      }),
    );
    expect(post.status).toBe(405);
    expect(post.headers.get('allow')).toBe('GET, HEAD, OPTIONS');
  });
});
