/**
 * The real transport, `imapflowTransport`, over a fake `imapflow` client (its factory injected, no module mock) :
 * the connection options (Gmail's host, implicit TLS, bounded timeouts, no
 * logger), a refused sign-in as `UpstreamAuthError`, logout after the work,
 * the abort signal and the deadline closing the connection, special use only
 * as the server reports it, and the commands each session method sends.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';

import type { ImapFlow, ImapFlowOptions } from 'imapflow';

import { UpstreamAuthError } from '@vaubaan/plugin-sdk';

import { createImapflowTransport } from '../../src/transport.ts';

interface MockClient {
  options: ImapFlowOptions;
  connect: ReturnType<typeof vi.fn>;
  logout: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
  getMailboxLock: ReturnType<typeof vi.fn>;
  search: ReturnType<typeof vi.fn>;
  fetchAll: ReturnType<typeof vi.fn>;
  download: ReturnType<typeof vi.fn>;
  append: ReturnType<typeof vi.fn>;
  messageFlagsAdd: ReturnType<typeof vi.fn>;
  messageFlagsRemove: ReturnType<typeof vi.fn>;
  mailboxCreate: ReturnType<typeof vi.fn>;
  released: string[];
}

const clients: MockClient[] = [];
let connectImpl: () => Promise<void> = async () => undefined;

/** A fake `imapflow` client, handed to the transport through its factory. */
function newClient(options: ImapFlowOptions): ImapFlow {
  const released: string[] = [];
  const client: MockClient = {
    options,
    released,
    connect: vi.fn(() => connectImpl()),
    logout: vi.fn(async () => undefined),
    close: vi.fn(),
    on: vi.fn(),
    list: vi.fn(async () => [
      {
        path: '[Gmail]/Tous les messages',
        specialUse: '\\All',
        specialUseSource: 'extension',
        flags: new Set<string>(),
        parentPath: '[Gmail]',
      },
      {
        path: 'Brouillons',
        specialUse: '\\Drafts',
        specialUseSource: 'name',
        flags: new Set<string>(),
        parentPath: '',
      },
      { path: '[Gmail]', flags: new Set(['\\Noselect']), parentPath: '' },
    ]),
    getMailboxLock: vi.fn(async (path: string) => ({ release: () => released.push(path) })),
    search: vi.fn(async () => [7, 3]),
    fetchAll: vi.fn(async () => [
      {
        uid: 3,
        emailId: '1785309829081492900',
        threadId: '1785309829081492899',
        labels: new Set(['\\Inbox']),
        flags: new Set(['\\Seen']),
        internalDate: new Date('2026-10-20T10:00:00Z'),
        envelope: { subject: 'Hi', from: [{ name: 'A', address: 'a@x.com' }] },
        bodyStructure: { type: 'text/plain' },
      },
      // Without Gmail's ids : dropped, never given a made-up id.
      { uid: 4, flags: new Set(), envelope: {} },
    ]),
    download: vi.fn(async () => ({
      meta: {},
      content: (async function* () {
        yield Buffer.from('Hello ');
        yield Buffer.from('world, this is long');
      })(),
    })),
    append: vi.fn(async () => ({ destination: 'x', uid: 99 })),
    messageFlagsAdd: vi.fn(async () => true),
    messageFlagsRemove: vi.fn(async () => true),
    mailboxCreate: vi.fn(async (path: string[]) => ({ path: path.join('/'), created: true })),
  };
  clients.push(client);
  return client as unknown as ImapFlow;
}

const imapflowTransport = createImapflowTransport(newClient);

const account = { email: 'me@gmail.com', appPassword: 'abcdefghijklmnop' };

beforeEach(() => {
  clients.length = 0;
  connectImpl = async () => undefined;
});

describe('imapflowTransport', () => {
  test('connects to imap.gmail.com:993 over implicit TLS, bounded, without a logger, and logs out', async () => {
    const result = await imapflowTransport.session(account, { timeoutMs: 60_000 }, async () => 42);
    expect(result).toBe(42);
    const [client] = clients;
    expect(client!.options).toMatchObject({
      host: 'imap.gmail.com',
      port: 993,
      secure: true,
      auth: { user: 'me@gmail.com', pass: 'abcdefghijklmnop' },
      logger: false,
      disableAutoIdle: true,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 30_000,
    });
    // An error event without a listener would crash the process.
    expect(client!.on).toHaveBeenCalledWith('error', expect.any(Function));
    expect(client!.logout).toHaveBeenCalledTimes(1);
  });

  test('a refused sign-in is an UpstreamAuthError naming the address, never the password', async () => {
    connectImpl = async () => {
      throw Object.assign(new Error('Invalid credentials'), {
        authenticationFailed: true,
        responseText: 'Invalid credentials (Failure)',
      });
    };
    const err = await imapflowTransport
      .session(account, { timeoutMs: 60_000 }, async () => 1)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamAuthError);
    expect((err as Error).message).toContain('me@gmail.com');
    expect((err as Error).message).toContain('Invalid credentials (Failure)');
    expect((err as Error).message).not.toContain('abcdefghijklmnop');
    expect(clients[0]!.close).toHaveBeenCalled();
  });

  test('an aborted call closes the connection', async () => {
    const controller = new AbortController();
    const pending = imapflowTransport.session(
      account,
      { timeoutMs: 60_000, signal: controller.signal },
      () => new Promise<number>(() => undefined),
    );
    await Promise.resolve();
    controller.abort();
    await expect(pending).rejects.toThrow(/aborted/);
    expect(clients[0]!.close).toHaveBeenCalled();
  });

  test('an already aborted call opens nothing', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      imapflowTransport.session(
        account,
        { timeoutMs: 60_000, signal: controller.signal },
        async () => 1,
      ),
    ).rejects.toThrow(/aborted/);
    expect(clients).toHaveLength(0);
  });

  test('the session deadline closes the connection', async () => {
    vi.useFakeTimers();
    try {
      const pending = imapflowTransport.session(
        account,
        { timeoutMs: 5_000 },
        () => new Promise<number>(() => undefined),
      );
      const settled = pending.catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(5_001);
      expect(String(await settled)).toMatch(/timed out after 5s/);
      expect(clients[0]!.close).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test('a special use is the server’s word only ; a container is not selectable', async () => {
    const mailboxes = await imapflowTransport.session(account, { timeoutMs: 60_000 }, (s) =>
      s.mailboxes(),
    );
    expect(mailboxes).toEqual([
      {
        path: '[Gmail]/Tous les messages',
        specialUse: '\\All',
        selectable: true,
        parentPath: '[Gmail]',
      },
      // Guessed from its name by imapflow : not trusted.
      { path: 'Brouillons', specialUse: null, selectable: true, parentPath: '' },
      { path: '[Gmail]', specialUse: null, selectable: false, parentPath: '' },
    ]);
  });

  test('search : read-only lock, the Gmail criterion, UIDs sorted, lock released', async () => {
    const uids = await imapflowTransport.session(account, { timeoutMs: 60_000 }, (s) =>
      s.search('ALL', { gmailRaw: 'from:a@x.com' }),
    );
    const c = clients[0]!;
    expect(uids).toEqual([3, 7]);
    expect(c.getMailboxLock).toHaveBeenCalledWith('ALL', { readOnly: true });
    expect(c.search).toHaveBeenCalledWith({ gmraw: 'from:a@x.com' }, { uid: true });
    expect(c.released).toEqual(['ALL']);

    await imapflowTransport.session(account, { timeoutMs: 60_000 }, async (s) => {
      await s.search('ALL', { threadId: '12' });
      await s.search('ALL', { messageId: '13' });
      await s.search('ALL', { all: true });
    });
    expect(clients[1]!.search.mock.calls.map((call: unknown[]) => call[0])).toEqual([
      { threadId: '12' },
      { emailId: '13' },
      { all: true },
    ]);
  });

  test('fetch : Gmail ids kept as decimal strings, a capped text body, a message without ids dropped', async () => {
    const messages = await imapflowTransport.session(account, { timeoutMs: 60_000 }, (s) =>
      s.fetch('ALL', [3, 4], { bodyBytes: 8 }),
    );
    expect(messages).toEqual([
      {
        uid: 3,
        messageId: '1785309829081492900',
        threadId: '1785309829081492899',
        labels: ['\\Inbox'],
        flags: ['\\Seen'],
        date: '2026-10-20T10:00:00.000Z',
        subject: 'Hi',
        from: [{ name: 'A', address: 'a@x.com' }],
        to: [],
        cc: [],
        bcc: [],
        body: { type: 'text/plain', content: 'Hello wo', truncated: true },
        attachments: [],
      },
    ]);
    expect(clients[0]!.download).toHaveBeenCalledWith('3', '1', { uid: true, maxBytes: 9 });
  });

  test('download : one part by UID, read-only, capped ; a part the server lacks is null', async () => {
    const part = await imapflowTransport.session(account, { timeoutMs: 60_000 }, (s) =>
      s.download('ALL', 3, '2', 10),
    );
    expect(part).toEqual({ content: Buffer.from('Hello worl'), truncated: true });
    const c = clients[0]!;
    expect(c.getMailboxLock).toHaveBeenCalledWith('ALL', { readOnly: true });
    expect(c.download).toHaveBeenCalledWith('3', '2', { uid: true, maxBytes: 11 });
    expect(c.released).toEqual(['ALL']);
  });

  test('createMailbox : the segments, joined by imapflow with the server delimiter', async () => {
    const created = await imapflowTransport.session(account, { timeoutMs: 60_000 }, (s) =>
      s.createMailbox(['Projets', 'Été']),
    );
    expect(clients[0]!.mailboxCreate).toHaveBeenCalledWith(['Projets', 'Été']);
    expect(created).toEqual({ path: 'Projets/Été', created: true });
  });

  test('store : X-GM-LABELS with useLabels, flags without ; append returns the UID', async () => {
    const uid = await imapflowTransport.session(account, { timeoutMs: 60_000 }, async (s) => {
      await s.store('ALL', [3], { op: 'add', labels: ['\\Starred'] });
      await s.store('ALL', [3], { op: 'remove', flags: ['\\Seen'] });
      return s.append('Drafts', 'raw', ['\\Draft']);
    });
    const c = clients[0]!;
    expect(c.messageFlagsAdd).toHaveBeenCalledWith([3], ['\\Starred'], {
      uid: true,
      useLabels: true,
    });
    expect(c.messageFlagsRemove).toHaveBeenCalledWith([3], ['\\Seen'], {
      uid: true,
      useLabels: false,
    });
    expect(c.append).toHaveBeenCalledWith('Drafts', 'raw', ['\\Draft']);
    expect(uid).toBe(99);
  });
});
