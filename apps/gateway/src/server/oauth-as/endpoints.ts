/**
 * Where the authorization server and its one protected resource live, and the
 * two discovery documents that say so (spec §4.1 bis "metadata discovery
 * included, so that a client such as Claude Code connects with no special
 * configuration").
 *
 * Every URL is built on the configured `public_url`, never on the host the
 * process sees behind the TLS terminator. The issuer is the public URL itself
 * (no trailing slash): RFC 8414 clients compare it, as a string, with the
 * entry of `authorization_servers` they followed.
 */
import type { ClientRegistrationPolicy } from '../config/types';
import { TOKEN_ENDPOINT_AUTH_METHODS } from '../store/types';

/** The single scope a delegation carries: managing the user's missions (spec §4.1 bis). */
export const MANAGEMENT_SCOPE = 'mgmt';

/** What a request is told when it asks for anything else. */
export const ONLY_SCOPE_MESSAGE = `the only scope of this server is "${MANAGEMENT_SCOPE}"`;

/** The scopes of a space-separated `scope` value (RFC 6749 §3.3). */
export function scopesOf(raw: string): string[] {
  return raw.split(/\s+/).filter((scope) => scope !== '');
}

/**
 * The rule of an authorization request: the scope asked for **includes** the
 * management scope (other values are ignored; the delegation carries `mgmt` only).
 */
export function asksForManagement(raw: string): boolean {
  return scopesOf(raw).includes(MANAGEMENT_SCOPE);
}

/**
 * The rule of a renewal: the scope asked for **does not widen** the delegation —
 * it names nothing but the management scope (RFC 6749 §6).
 */
export function staysWithinManagement(raw: string): boolean {
  return scopesOf(raw).every((scope) => scope === MANAGEMENT_SCOPE);
}

/** Whether the scopes a delegated token carries open the management door. */
export function carriesManagementScope(scopes: readonly string[]): boolean {
  return scopes.includes(MANAGEMENT_SCOPE);
}

/** The management MCP door, the one resource this authorization server protects. */
export const MANAGEMENT_DOOR_PATH = '/mcp/manage';

export const AUTHORIZE_PATH = '/oauth/authorize';
/** Where the consent screen posts the user's answer. */
export const CONSENT_DECISION_PATH = '/oauth/authorize/decision';
export const TOKEN_PATH = '/oauth/token';
export const REGISTER_PATH = '/oauth/register';
export const REVOKE_PATH = '/oauth/revoke';
/** RFC 8414. */
export const AUTHORIZATION_SERVER_METADATA_PATH = '/.well-known/oauth-authorization-server';
/** RFC 9728, path-aware: the well-known prefix followed by the resource's path. */
export const PROTECTED_RESOURCE_METADATA_PATH = `/.well-known/oauth-protected-resource${MANAGEMENT_DOOR_PATH}`;

export const SUPPORTED_GRANT_TYPES = ['authorization_code', 'refresh_token'] as const;
export const SUPPORTED_RESPONSE_TYPES = ['code'] as const;
export const SUPPORTED_CODE_CHALLENGE_METHODS = ['S256'] as const;

export interface OAuthEndpoints {
  /** The issuer identifier: `public_url` without a trailing slash. */
  readonly issuer: string;
  /** The RFC 8707 resource identifier of the management door. */
  readonly resource: string;
  /** The RFC 9728 document of that resource, named in the door's 401 challenge. */
  readonly resourceMetadataUrl: string;
  readonly authorize: string;
  readonly token: string;
  readonly register: string;
  readonly revoke: string;
}

export function oauthEndpoints(publicUrl: URL): OAuthEndpoints {
  const base = publicUrl.href.replace(/\/+$/, '');
  return {
    issuer: base,
    resource: `${base}${MANAGEMENT_DOOR_PATH}`,
    resourceMetadataUrl: `${base}${PROTECTED_RESOURCE_METADATA_PATH}`,
    authorize: `${base}${AUTHORIZE_PATH}`,
    token: `${base}${TOKEN_PATH}`,
    register: `${base}${REGISTER_PATH}`,
    revoke: `${base}${REVOKE_PATH}`,
  };
}

/** A resource indicator without its fragment and trailing slash, for comparison. */
function comparableResource(value: string): string {
  const hash = value.indexOf('#');
  return (hash === -1 ? value : value.slice(0, hash)).replace(/\/$/, '');
}

/** Whether an RFC 8707 `resource` parameter names the management door. */
export function isManagementResource(endpoints: OAuthEndpoints, presented: string): boolean {
  return comparableResource(presented) === comparableResource(endpoints.resource);
}

/**
 * RFC 8707: the first `resource` value of a request that is not the management
 * door, or `null` when every value names it (or none was sent).
 */
export function foreignResource(
  endpoints: OAuthEndpoints,
  resources: readonly string[],
): string | null {
  return resources.find((resource) => !isManagementResource(endpoints, resource)) ?? null;
}

/** What a request naming another resource is told. */
export function onlyResourceMessage(endpoints: OAuthEndpoints): string {
  return `this server only issues tokens for ${endpoints.resource}`;
}

export interface MetadataOptions {
  readonly policy: ClientRegistrationPolicy;
  readonly metadataDocuments: boolean;
}

/**
 * RFC 8414 authorization server metadata. `registration_endpoint` is absent
 * under the `closed` policy (nothing registers), and
 * `client_id_metadata_document_supported` follows the configuration.
 */
export function authorizationServerMetadata(
  endpoints: OAuthEndpoints,
  options: MetadataOptions,
): Record<string, unknown> {
  return {
    issuer: endpoints.issuer,
    authorization_endpoint: endpoints.authorize,
    token_endpoint: endpoints.token,
    ...(options.policy === 'closed' ? {} : { registration_endpoint: endpoints.register }),
    revocation_endpoint: endpoints.revoke,
    scopes_supported: [MANAGEMENT_SCOPE],
    response_types_supported: [...SUPPORTED_RESPONSE_TYPES],
    response_modes_supported: ['query'],
    grant_types_supported: [...SUPPORTED_GRANT_TYPES],
    token_endpoint_auth_methods_supported: [...TOKEN_ENDPOINT_AUTH_METHODS],
    revocation_endpoint_auth_methods_supported: [...TOKEN_ENDPOINT_AUTH_METHODS],
    code_challenge_methods_supported: [...SUPPORTED_CODE_CHALLENGE_METHODS],
    // RFC 9207: the authorization response names its issuer (mix-up defence).
    authorization_response_iss_parameter_supported: true,
    client_id_metadata_document_supported: options.metadataDocuments,
  };
}

/** RFC 9728 protected resource metadata of the management door. */
export function protectedResourceMetadata(endpoints: OAuthEndpoints): Record<string, unknown> {
  return {
    resource: endpoints.resource,
    authorization_servers: [endpoints.issuer],
    scopes_supported: [MANAGEMENT_SCOPE],
    bearer_methods_supported: ['header'],
    resource_name: 'Vaubaan Gateway — mission management',
  };
}

/**
 * RFC 9728 protected resource metadata of the **execution** door (`/mcp`),
 * served at the path-less well-known URL. That door takes a static bearer, the
 * mission token, and has no authorization server: an empty
 * `authorization_servers` tells an MCP client that probes on connect to use
 * the bearer it was configured with and not to attempt a registration.
 */
export function executionResourceMetadata(
  endpoints: OAuthEndpoints,
  executionDoorPath: string,
): Record<string, unknown> {
  return {
    // Built on the issuer, like every URL of this file: one base-URL rule.
    resource: `${endpoints.issuer}${executionDoorPath}`,
    authorization_servers: [],
    bearer_methods_supported: ['header'],
  };
}
