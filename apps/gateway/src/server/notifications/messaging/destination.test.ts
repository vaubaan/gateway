/**
 * A free-host address must lead to the public internet (spec §6): `localhost`, private and
 * reserved IP literals, and names with any non-public record are refused. No network: the
 * resolver is a fake.
 */
import { describe, expect, it } from 'vitest';

import { destinationOf } from './destination';

const resolvesTo =
  (...addresses: string[]) =>
  async () =>
    addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
const never = async (): Promise<never> => {
  throw new Error('the resolver must not be asked');
};

describe('destination of a free-host address', () => {
  it('refuses localhost by name, without resolving it', async () => {
    for (const host of ['localhost', 'LOCALHOST', 'api.localhost', 'localhost.']) {
      expect(await destinationOf(new URL(`https://${host}/x`), never)).toBe('private');
    }
  });

  it('refuses IP literals outside the public internet, and takes a public one', async () => {
    for (const host of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '[::1]',
      '[fd00::1]',
      '[fe80::1]',
      '[::ffff:127.0.0.1]',
    ]) {
      expect(await destinationOf(new URL(`https://${host}/x`), never)).toBe('private');
    }
    expect(await destinationOf(new URL('https://93.184.215.14/x'), never)).toBe('public');
  });

  it('refuses a name when any of its addresses is not public', async () => {
    const url = new URL('https://ntfy.acme.example/alerts');
    expect(await destinationOf(url, resolvesTo('93.184.215.14'))).toBe('public');
    expect(await destinationOf(url, resolvesTo('10.0.0.5'))).toBe('private');
    expect(await destinationOf(url, resolvesTo('93.184.215.14', '192.168.0.2'))).toBe('private');
    expect(await destinationOf(url, resolvesTo('2606:2800:21f:cb07:6820:80da:af6b:8b2c'))).toBe(
      'public',
    );
  });

  it('reads a name that does not resolve as unresolved', async () => {
    const url = new URL('https://nowhere.example/x');
    expect(await destinationOf(url, resolvesTo())).toBe('unresolved');
    expect(
      await destinationOf(url, async () => {
        throw new Error('ENOTFOUND');
      }),
    ).toBe('unresolved');
  });
});
