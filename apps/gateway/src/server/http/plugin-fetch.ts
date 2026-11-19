/**
 * The `fetch` handed to plugins (ADR plugins-reach-the-public-internet-only): it reaches
 * the public internet, and inside the network only the hosts and ranges the operator lists
 * in `plugins.private_hosts`. A signed-in person chooses some services' addresses (a CalDAV
 * server URL), so without it any person could make the instance probe its loopback and
 * its network, credential attached.
 *
 * Enforced on every socket the request opens, redirects included:
 * - an IP address that is not allowed is refused before any connection;
 * - a name resolves once, and is refused when any of its addresses is not allowed
 *   (as `publicOnlyLookup` does), so a name cannot hold one public and one private record;
 * - the connected peer is checked again, so a name re-pointed between the lookup and the
 *   connection reaches nothing (DNS rebinding).
 * A host name the operator lists is reached as it resolves, without any check.
 */
import { isIP } from 'node:net';

import { Agent, buildConnector } from 'undici';

import { reachable, type PrivateHosts } from './private-hosts';
import { systemResolver, type Resolver } from './public-address';

export { parsePrivateHosts, reachable, type PrivateHosts } from './private-hosts';

/** A plugin's request to an address the instance does not let plugins reach. */
export class PrivateAddressError extends Error {
  constructor(host: string) {
    super(
      `${host} is not on the public internet, and plugins.private_hosts does not list it: the gateway does not connect to it`,
    );
    this.name = 'PrivateAddressError';
  }
}

/** The host of a connection as undici gives it: `[::1]` without its brackets, lowercased. */
function bareHost(hostname: string): string {
  return hostname.replace(/^\[(.*)\]$/, '$1').toLowerCase();
}

export interface PluginFetchOptions {
  readonly privateHosts: PrivateHosts;
  /** Tests inject a fake; the system's resolver otherwise. */
  readonly resolve?: Resolver;
  /** The `fetch` the dispatcher is given to; the global one otherwise. */
  readonly fetch?: typeof fetch;
}

/** The undici dispatcher whose every socket obeys `plugins.private_hosts`. */
export function pluginDispatcher(options: PluginFetchOptions): Agent {
  const { privateHosts } = options;
  const resolve = options.resolve ?? systemResolver;
  const filtered = buildConnector({
    lookup: (hostname, opts, callback) => {
      resolve(hostname).then(
        (addresses) => {
          if (
            addresses.length === 0 ||
            addresses.some((a) => !reachable(a.address, privateHosts))
          ) {
            callback(new PrivateAddressError(hostname), '');
            return;
          }
          if (opts.all) {
            callback(null, [...addresses]);
            return;
          }
          const first = addresses[0];
          if (first) callback(null, first.address, first.family);
        },
        (err: unknown) => callback(err instanceof Error ? err : new Error(String(err)), ''),
      );
    },
  });
  const plain = buildConnector({});
  return new Agent({
    connect: (opts, callback) => {
      const host = bareHost(opts.hostname);
      if (privateHosts.names.has(host)) {
        plain(opts, callback);
        return;
      }
      if (isIP(host) !== 0 && !reachable(host, privateHosts)) {
        callback(new PrivateAddressError(host), null);
        return;
      }
      filtered(opts, (err, socket) => {
        if (err || !socket) {
          callback(err ?? new PrivateAddressError(host), null);
          return;
        }
        const peer = socket.remoteAddress;
        if (!peer || !reachable(peer, privateHosts)) {
          socket.destroy();
          callback(new PrivateAddressError(host), null);
          return;
        }
        callback(null, socket);
      });
    },
  });
}

/** `fetch` through {@link pluginDispatcher}: what the plugins receive in production. */
export function pluginFetch(options: PluginFetchOptions): typeof fetch {
  const dispatcher = pluginDispatcher(options);
  const base = options.fetch ?? fetch;
  return (input, init) => base(input, { ...init, dispatcher } as RequestInit);
}
