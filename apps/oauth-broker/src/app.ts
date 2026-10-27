/**
 * Assembles a running broker from its parts. src/main.ts calls it with the
 * compiled-in providers and the platform the image names; tests call it with
 * a fake provider and the local adapter.
 */
import { type AddressInfo } from 'node:net';
import { type Server } from 'node:http';
import { Broker } from './broker.ts';
import { type BrokerConfig } from './config.ts';
import { FlowStore } from './flows.ts';
import { AttestRateLimit } from './rate-limit.ts';
import { type Logger } from './log.ts';
import { type Fetch, OAuthClient } from './oauth-client.ts';
import { type PlatformAdapter } from './platform/types.ts';
import { type ProviderTable } from './providers.ts';
import { createApiServer, createCallbackServer } from './server.ts';
import { createTlsIdentity } from './tls-identity.ts';

export interface StartOptions {
  readonly config: BrokerConfig;
  readonly providers: ProviderTable;
  readonly platform: PlatformAdapter;
  readonly log: Logger;
  readonly fetch?: Fetch;
  readonly now?: () => number;
  readonly attestLimit?: AttestRateLimit;
  /** Listen address; all interfaces by default (the enclave has no other tenant). */
  readonly host?: string;
}

export interface RunningBroker {
  readonly apiPort: number;
  readonly httpPort: number;
  readonly publicKeySha256: string;
  /** The PEM certificate of the API listener (public). */
  readonly certificate: string;
  close(): Promise<void>;
}

function listen(server: Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve((server.address() as AddressInfo).port));
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

export async function startBroker(options: StartOptions): Promise<RunningBroker> {
  const { config, providers, platform, log } = options;
  const secrets = new Map<string, string>();
  for (const [id, client] of config.clients) {
    secrets.set(id, await platform.unsealSecret(client.secretName));
  }
  const tls = createTlsIdentity();
  const flows = new FlowStore(options.now === undefined ? {} : { now: options.now });
  const broker = new Broker({
    config,
    providers,
    secrets,
    platform,
    publicKeySha256: tls.publicKeySha256,
    flows,
    oauth: new OAuthClient(options.fetch ?? fetch, options.now ?? Date.now),
    attestLimit: options.attestLimit ?? new AttestRateLimit(),
  });
  const sweeper = setInterval(() => flows.sweep(), 60_000);
  sweeper.unref();

  const host = options.host ?? '0.0.0.0';
  const api = createApiServer(broker, tls, log);
  const http = createCallbackServer(broker, log);
  const apiPort = await listen(api, config.apiPort, host);
  const httpPort = await listen(http, config.httpPort, host);
  log.info('started', {
    platform: platform.name,
    api_port: apiPort,
    http_port: httpPort,
    providers: [...secrets.keys()].join(','),
    instances: config.instances.length,
    tls_public_key_sha256: tls.publicKeySha256,
  });
  return {
    apiPort,
    httpPort,
    publicKeySha256: tls.publicKeySha256,
    certificate: tls.cert,
    async close() {
      clearInterval(sweeper);
      await Promise.all([close(api), close(http)]);
    },
  };
}
