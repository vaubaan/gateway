/**
 * The messaging transport: what leaves (JSON, no redirect, a deadline), what an answer means,
 * and that a URL failing its rules or leading inside a private network never leaves — by
 * name before the request, and at the socket when the name was re-pointed after the check.
 */
import { describe, expect, it } from 'vitest';

import type { OutgoingMessage } from './messages';
import { fetchPoster, PrivateDestinationError, publicOnlyPoster, type Poster } from './posters';
import { createMessagingTransport } from './transport';

const MESSAGE: OutgoingMessage = {
  title: 'Acme',
  body: 'Something.',
  url: 'https://gateway.example.com/x',
  kind: 'backup-failed',
  instance: 'Acme',
};
const PUBLIC = async () => [{ address: '93.184.215.14', family: 4 }];

function rig(status = 200, address = '93.184.215.14') {
  const calls: { url: string; init: RequestInit }[] = [];
  const post = fetchPoster(async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(null, { status });
  });
  const transport = createMessagingTransport({
    vendorPost: post,
    freeHostPost: post,
    resolve: async () => [{ address, family: 4 }],
  });
  return { transport, calls };
}

describe('messaging transport', () => {
  it('posts JSON, follows no redirect and gives up after a deadline', async () => {
    const { transport, calls } = rig(204);
    const outcome = await transport.send(
      'slack',
      'https://hooks.slack.com/services/T/B/x',
      MESSAGE,
    );
    expect(outcome).toEqual({ kind: 'delivered' });
    const [call] = calls;
    expect(call?.init.method).toBe('POST');
    expect(call?.init.redirect).toBe('error');
    expect(call?.init.signal).toBeInstanceOf(AbortSignal);
    expect(new Headers(call?.init.headers).get('content-type')).toBe('application/json');
  });

  it('reads anything but 2xx as a failure with its status, and no answer as null', async () => {
    expect(await rig(500).transport.send('generic', 'https://h.example.com/x', MESSAGE)).toEqual({
      kind: 'failed',
      status: 500,
    });
    const down: Poster = async () => {
      throw new TypeError('fetch failed');
    };
    const transport = createMessagingTransport({
      vendorPost: down,
      freeHostPost: down,
      resolve: PUBLIC,
    });
    expect(await transport.send('generic', 'https://h.example.com/x', MESSAGE)).toEqual({
      kind: 'failed',
      status: null,
    });
  });

  it('sends nothing to a private destination or a URL that no longer passes its rules', async () => {
    const { transport, calls } = rig(200, '10.0.0.7');
    expect(await transport.send('ntfy', 'https://ntfy.acme.example/alerts', MESSAGE)).toEqual({
      kind: 'refused',
      refusal: 'private-destination',
    });
    expect(await transport.send('slack', 'https://hooks.example.com/services/x', MESSAGE)).toEqual({
      kind: 'refused',
      refusal: 'wrong-host',
    });
    expect(calls).toEqual([]);
  });

  it('reads a socket refused for a re-pointed name as a private destination', async () => {
    const transport = createMessagingTransport({
      vendorPost: async () => 200,
      freeHostPost: async () => {
        throw new PrivateDestinationError();
      },
      resolve: PUBLIC,
    });
    expect(await transport.send('generic', 'https://h.example.com/x', MESSAGE)).toEqual({
      kind: 'refused',
      refusal: 'private-destination',
    });
  });

  it('does not resolve the vendors’ hosts, and posts them through the vendor poster', async () => {
    const used: string[] = [];
    const transport = createMessagingTransport({
      vendorPost: async () => {
        used.push('vendor');
        return 200;
      },
      freeHostPost: async () => {
        used.push('free');
        return 200;
      },
      resolve: async () => {
        throw new Error('the resolver must not be asked');
      },
    });
    expect(
      await transport.send('discord', 'https://discord.com/api/webhooks/1/t', MESSAGE),
    ).toEqual({ kind: 'delivered' });
    expect(used).toEqual(['vendor']);
  });
});

describe('the pinned poster of the free hosts', () => {
  it('never connects to a name that resolves inside the network', async () => {
    // A name re-pointed to the loopback after its check: the socket is refused at lookup.
    const post = publicOnlyPoster(async () => [{ address: '127.0.0.1', family: 4 }]);
    await expect(post('https://rebound.example.com/hook', { a: 1 })).rejects.toBeInstanceOf(
      PrivateDestinationError,
    );
    const mixed = publicOnlyPoster(async () => [
      { address: '93.184.215.14', family: 4 },
      { address: '169.254.169.254', family: 4 },
    ]);
    await expect(mixed('https://mixed.example.com/hook', {})).rejects.toBeInstanceOf(
      PrivateDestinationError,
    );
  });
});
