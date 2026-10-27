/**
 * The OAuth client of an `oauth2` service — the one place the connect flows
 * (`ConnectionService`) and the credential broker (refresh, revocation) get
 * it from. There is one origin: the spec declares `clientRegistration`
 * (RFC 7591), and this instance registers its own client at the provider the
 * first time someone connects, keeps it, and reuses it for every connection
 * (Miro's MCP server). No administrator declares a client (ADRs
 * oauth-client-registered-by-the-gateway, gmail-over-imap-with-an-app-password).
 *
 * The client lives in `instance_config` under `oauth_clients.<provider>.*`:
 * `client_id`, `redirect_uri` and `registered_at` as values, `client_secret`
 * sealed by the store's encryptor. It is registered again when there is none,
 * when the instance's callback address is no longer the one it was registered
 * with (the public URL changed), and after the provider rejected it
 * (`invalid_client`): `rejected` forgets it. Registrations are single-flight
 * per provider inside this process, so two people connecting at once share
 * one client.
 */
import type { OAuth2RegisteredClientSpec, ProviderPlugin } from '@vaubaan/plugin-sdk';

import type { Logger } from '../logging';
import type { ConfigRepo } from '../store/repositories/config';
import { toIso, type Clock } from '../store/clock';
import { registerClient, type OAuth2Client } from './oauth2';

export const OAUTH_CLIENT_KEY_PREFIX = 'oauth_clients';

/** The keys of one provider's registered client in `instance_config`. */
export function registeredClientKey(
  providerId: string,
  field: 'client_id' | 'client_secret' | 'redirect_uri' | 'registered_at',
): string {
  return `${OAUTH_CLIENT_KEY_PREFIX}.${providerId}.${field}`;
}

/** The name the provider shows on its consent page and in the person's list of apps. */
export const REGISTERED_CLIENT_NAME = 'Vaubaan Gateway';

/** No registered client is kept for the service (never registered, or forgotten after a rejection). */
export class OAuth2ClientMissing extends Error {
  constructor(readonly providerId: string) {
    super(`provider '${providerId}': no OAuth client is registered`);
    this.name = 'OAuth2ClientMissing';
  }
}

export interface OAuth2ClientsDeps {
  readonly config: Pick<ConfigRepo, 'get' | 'getSecret' | 'apply'>;
  /** The instance's public URL: its host names the client at the provider. */
  readonly publicUrl: URL;
  readonly fetch: typeof fetch;
  readonly clock: Clock;
  readonly logger: Logger;
}

type ProviderOf = Pick<ProviderPlugin, 'id'>;

export class OAuth2Clients {
  // single-process only — one registration at a time per provider inside this process.
  private readonly registering = new Map<string, Promise<OAuth2Client>>();

  constructor(private readonly deps: OAuth2ClientsDeps) {}

  /**
   * The client of an authorization that starts now, for `redirectUri`: the
   * registered one — registered first when there is none, or when it was
   * registered for another callback address. Throws `OAuth2RegistrationError`.
   */
  async forAuthorization(
    plugin: ProviderOf,
    spec: OAuth2RegisteredClientSpec,
    redirectUri: string,
  ): Promise<OAuth2Client> {
    const stored = await this.stored(plugin.id, spec);
    if (stored && stored.redirectUri === redirectUri) return stored.client;
    return this.register(plugin.id, spec, redirectUri);
  }

  /**
   * The client of a token request (code exchange, refresh, revocation): the
   * registered one as it is. Never registers: a grant belongs to the client
   * that obtained it. Throws `OAuth2ClientMissing`.
   */
  async forTokenRequest(
    plugin: ProviderOf,
    spec: OAuth2RegisteredClientSpec,
  ): Promise<OAuth2Client> {
    const stored = await this.stored(plugin.id, spec);
    if (!stored) throw new OAuth2ClientMissing(plugin.id);
    return stored.client;
  }

  /**
   * The provider answered `invalid_client` for `clientId`: the registered
   * client is forgotten (when it is still that one), so the next connection
   * registers again.
   */
  async rejected(
    plugin: ProviderOf,
    _spec: OAuth2RegisteredClientSpec,
    clientId: string,
  ): Promise<void> {
    const current = await this.deps.config.get(registeredClientKey(plugin.id, 'client_id'));
    if (current !== clientId) return;
    await this.deps.config.apply(
      (['client_id', 'client_secret', 'redirect_uri', 'registered_at'] as const).map((field) => ({
        kind: 'delete' as const,
        key: registeredClientKey(plugin.id, field),
      })),
    );
    this.deps.logger.warn('registered OAuth client rejected by the provider; forgotten', {
      provider: plugin.id,
    });
  }

  private async stored(
    providerId: string,
    spec: OAuth2RegisteredClientSpec,
  ): Promise<{ readonly client: OAuth2Client; readonly redirectUri: string | null } | null> {
    const { config } = this.deps;
    const clientId = await config.get(registeredClientKey(providerId, 'client_id'));
    if (!clientId) return null;
    const isPublic = spec.clientAuthMethod === 'none';
    const clientSecret = isPublic
      ? null
      : await config.getSecret(registeredClientKey(providerId, 'client_secret'));
    // A confidential client without its secret cannot be used: register again.
    if (!isPublic && !clientSecret) return null;
    return {
      client: { clientId, clientSecret },
      redirectUri: await config.get(registeredClientKey(providerId, 'redirect_uri')),
    };
  }

  private register(
    providerId: string,
    spec: OAuth2RegisteredClientSpec,
    redirectUri: string,
  ): Promise<OAuth2Client> {
    const inFlight = this.registering.get(providerId);
    if (inFlight) return inFlight;
    const pending = this.registerNow(providerId, spec, redirectUri).finally(() => {
      this.registering.delete(providerId);
    });
    this.registering.set(providerId, pending);
    return pending;
  }

  private async registerNow(
    providerId: string,
    spec: OAuth2RegisteredClientSpec,
    redirectUri: string,
  ): Promise<OAuth2Client> {
    const client = await registerClient(
      spec.clientRegistration,
      spec,
      { redirectUri, clientName: `${REGISTERED_CLIENT_NAME} (${this.deps.publicUrl.host})` },
      { fetch: this.deps.fetch },
    );
    await this.deps.config.apply([
      { kind: 'value', key: registeredClientKey(providerId, 'client_id'), value: client.clientId },
      client.clientSecret === null
        ? { kind: 'delete', key: registeredClientKey(providerId, 'client_secret') }
        : {
            kind: 'secret',
            key: registeredClientKey(providerId, 'client_secret'),
            plain: client.clientSecret,
          },
      { kind: 'value', key: registeredClientKey(providerId, 'redirect_uri'), value: redirectUri },
      {
        kind: 'value',
        key: registeredClientKey(providerId, 'registered_at'),
        value: toIso(this.deps.clock.now()),
      },
    ]);
    this.deps.logger.info('OAuth client registered at the provider', {
      provider: providerId,
      client_id: client.clientId,
    });
    return client;
  }
}
