import { describe, expect, it } from 'vitest';

import {
  authorizationServerMetadata,
  isManagementResource,
  MANAGEMENT_SCOPE,
  oauthEndpoints,
  protectedResourceMetadata,
} from './endpoints';

const endpoints = oauthEndpoints(new URL('https://gateway.example.com'));

describe('endpoints of the authorization server', () => {
  it('builds every URL on the public URL, the issuer being that URL without a trailing slash', () => {
    expect(endpoints).toEqual({
      issuer: 'https://gateway.example.com',
      resource: 'https://gateway.example.com/mcp/manage',
      resourceMetadataUrl:
        'https://gateway.example.com/.well-known/oauth-protected-resource/mcp/manage',
      authorize: 'https://gateway.example.com/oauth/authorize',
      token: 'https://gateway.example.com/oauth/token',
      register: 'https://gateway.example.com/oauth/register',
      revoke: 'https://gateway.example.com/oauth/revoke',
    });
  });

  it('keeps a sub-path of the public URL', () => {
    const nested = oauthEndpoints(new URL('https://intranet.example.com/gateway'));
    expect(nested.issuer).toBe('https://intranet.example.com/gateway');
    expect(nested.token).toBe('https://intranet.example.com/gateway/oauth/token');
  });

  it('recognises the management door as a resource indicator, and only it', () => {
    expect(isManagementResource(endpoints, 'https://gateway.example.com/mcp/manage')).toBe(true);
    expect(isManagementResource(endpoints, 'https://gateway.example.com/mcp/manage/')).toBe(true);
    expect(isManagementResource(endpoints, 'https://gateway.example.com/mcp/manage#x')).toBe(true);
    for (const other of [
      'https://gateway.example.com/mcp',
      'https://gateway.example.com',
      'https://gateway.example.com/mcp/manage/tools',
      'https://evil.example/mcp/manage',
      'http://gateway.example.com/mcp/manage',
      '',
    ]) {
      expect(isManagementResource(endpoints, other)).toBe(false);
    }
  });
});

describe('RFC 8414 metadata', () => {
  const metadata = authorizationServerMetadata(endpoints, {
    policy: 'operator-approved',
    metadataDocuments: false,
  });

  it('describes a server that only does the code flow with PKCE S256 and one scope', () => {
    expect(metadata).toMatchObject({
      issuer: 'https://gateway.example.com',
      authorization_endpoint: 'https://gateway.example.com/oauth/authorize',
      token_endpoint: 'https://gateway.example.com/oauth/token',
      registration_endpoint: 'https://gateway.example.com/oauth/register',
      revocation_endpoint: 'https://gateway.example.com/oauth/revoke',
      scopes_supported: [MANAGEMENT_SCOPE],
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'client_secret_post'],
      authorization_response_iss_parameter_supported: true,
      client_id_metadata_document_supported: false,
    });
  });

  it('advertises neither the implicit flow, nor plain PKCE, nor a password or client-credentials grant', () => {
    const text = JSON.stringify(metadata);
    for (const absent of ['"token"', 'plain', 'password', 'client_credentials', 'implicit']) {
      expect(text).not.toContain(absent);
    }
  });

  it('omits the registration endpoint when registration is closed', () => {
    const closed = authorizationServerMetadata(endpoints, {
      policy: 'closed',
      metadataDocuments: false,
    });
    expect(closed).not.toHaveProperty('registration_endpoint');
  });

  it('advertises metadata documents only when the operator enabled them', () => {
    expect(
      authorizationServerMetadata(endpoints, { policy: 'open', metadataDocuments: true })
        .client_id_metadata_document_supported,
    ).toBe(true);
  });
});

describe('RFC 9728 metadata of the management door', () => {
  it('names the resource, this instance as its authorization server, and the scope', () => {
    expect(protectedResourceMetadata(endpoints)).toMatchObject({
      resource: 'https://gateway.example.com/mcp/manage',
      authorization_servers: ['https://gateway.example.com'],
      scopes_supported: [MANAGEMENT_SCOPE],
      bearer_methods_supported: ['header'],
    });
  });
});
