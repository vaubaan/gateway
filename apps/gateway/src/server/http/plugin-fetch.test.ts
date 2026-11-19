/**
 * The plugins' `fetch` reaches the public internet only, and inside the network only what
 * `plugins.private_hosts` lists (ADR plugins-reach-the-public-internet-only): a local
 * server stands for the instance's loopback and network.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parsePrivateHosts, pluginFetch, PrivateAddressError, reachable } from './plugin-fetch';
import type { Resolver } from './public-address';

let server: Server;
let port = 0;
const hits: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    hits.push(req.url ?? '');
    if (req.url === '/redirect') {
      res.writeHead(302, { location: `http://127.0.0.1:${port}/secret` }).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' }).end('inside');
  });
  // Every loopback address (127.0.0.2 included), as an internal host would answer.
  await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** A resolver that knows the names given, and nothing else. */
function names(table: Record<string, readonly string[]>): Resolver {
  return (hostname) => {
    const found = table[hostname];
    if (!found) return Promise.reject(new Error(`ENOTFOUND ${hostname}`));
    return Promise.resolve(
      found.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })),
    );
  };
}

async function refusal(promise: Promise<Response>): Promise<unknown> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(Error);
  return (err as Error).cause;
}

describe('the plugins’ fetch', () => {
  it('refuses a loopback or private address, before connecting', async () => {
    const reach = pluginFetch({ privateHosts: parsePrivateHosts([]) });
    const before = hits.length;
    expect(await refusal(reach(`http://127.0.0.1:${port}/probe`))).toBeInstanceOf(
      PrivateAddressError,
    );
    expect(await refusal(reach(`http://[::1]:${port}/probe`))).toBeInstanceOf(PrivateAddressError);
    expect(hits.length).toBe(before);
  });

  it('refuses a name with any address inside the network, a public one beside it included', async () => {
    const reach = pluginFetch({
      privateHosts: parsePrivateHosts([]),
      resolve: names({
        'calendar.example.com': ['127.0.0.1'],
        'mixed.example.com': ['93.184.216.34', '127.0.0.1'],
      }),
    });
    const before = hits.length;
    expect(await refusal(reach(`http://calendar.example.com:${port}/`))).toBeInstanceOf(
      PrivateAddressError,
    );
    expect(await refusal(reach(`http://mixed.example.com:${port}/`))).toBeInstanceOf(
      PrivateAddressError,
    );
    expect(hits.length).toBe(before);
  });

  it('reaches what the operator lists: a range, an address, a name', async () => {
    const byRange = pluginFetch({
      privateHosts: parsePrivateHosts(['127.0.0.0/8']),
      resolve: names({ 'calendar.corp': ['127.0.0.1'] }),
    });
    expect(await (await byRange(`http://127.0.0.1:${port}/a`)).text()).toBe('inside');
    expect(await (await byRange(`http://calendar.corp:${port}/b`)).text()).toBe('inside');
    const byName = pluginFetch({ privateHosts: parsePrivateHosts(['localhost']) });
    expect((await byName(`http://localhost:${port}/c`)).status).toBe(200);
  });

  it('checks every hop: a listed host cannot redirect to one that is not', async () => {
    const reach = pluginFetch({ privateHosts: parsePrivateHosts(['127.0.0.2']) });
    const before = hits.filter((h) => h === '/secret').length;
    expect(await refusal(reach(`http://127.0.0.2:${port}/redirect`))).toBeInstanceOf(
      PrivateAddressError,
    );
    expect(hits.filter((h) => h === '/secret').length).toBe(before);
  });

  it('reads plugins.private_hosts strictly', () => {
    const hosts = parsePrivateHosts(['10.0.0.0/8', 'FD00::/8', '192.168.1.20', 'Nextcloud.corp']);
    expect(reachable('10.1.2.3', hosts)).toBe(true);
    expect(reachable('::ffff:10.1.2.3', hosts)).toBe(true);
    expect(reachable('fd12::1', hosts)).toBe(true);
    expect(reachable('192.168.1.20', hosts)).toBe(true);
    expect(reachable('192.168.1.21', hosts)).toBe(false);
    expect(reachable('169.254.169.254', hosts)).toBe(false);
    expect(reachable('8.8.8.8', hosts)).toBe(true);
    expect(hosts.names.has('nextcloud.corp')).toBe(true);
    expect(() => parsePrivateHosts(['10.0.0.0/33'])).toThrow(/not a CIDR range/);
    expect(() => parsePrivateHosts(['http://x'])).toThrow(/neither/);
  });
});
