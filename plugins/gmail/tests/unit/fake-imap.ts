/**
 * An in-memory Gmail behind the `GmailTransport` interface : folders with
 * SPECIAL-USE, messages carrying `X-GM-MSGID` / `X-GM-THRID` (decimal) and
 * labels, every call recorded. A test never opens a socket.
 *
 * The folder names are localized on purpose (`[Gmail]/Tous les messages`) :
 * the plugin must find its folders by special use, never by name.
 */
import { UpstreamAuthError } from '@vaubaan/plugin-sdk';

import type {
  GmailAccount,
  GmailImapSession,
  GmailSessionOptions,
  GmailTransport,
  ImapAddress,
  ImapBody,
  ImapFetchOptions,
  ImapMailbox,
  ImapMessage,
  ImapSearch,
  ImapStore,
} from '../../src/index.ts';

export const ALL = '[Gmail]/Tous les messages';
export const DRAFTS = '[Gmail]/Brouillons';

export const FOLDERS: readonly ImapMailbox[] = [
  { path: 'INBOX', specialUse: null, selectable: true, parentPath: '' },
  { path: '[Gmail]', specialUse: null, selectable: false, parentPath: '' },
  { path: ALL, specialUse: '\\All', selectable: true, parentPath: '[Gmail]' },
  { path: DRAFTS, specialUse: '\\Drafts', selectable: true, parentPath: '[Gmail]' },
  { path: '[Gmail]/Corbeille', specialUse: '\\Trash', selectable: true, parentPath: '[Gmail]' },
  { path: '[Gmail]/Spam', specialUse: '\\Junk', selectable: true, parentPath: '[Gmail]' },
  { path: '[Gmail]/Important', specialUse: '\\Important', selectable: true, parentPath: '[Gmail]' },
  // A folder under the system container without a special use : never a user label.
  { path: '[Gmail]/Chats', specialUse: null, selectable: true, parentPath: '[Gmail]' },
  { path: 'Legal', specialUse: null, selectable: true, parentPath: '' },
  { path: 'Legal/Contracts', specialUse: null, selectable: true, parentPath: 'Legal' },
  { path: 'Receipts', specialUse: null, selectable: true, parentPath: '' },
];

export interface FakeMessage {
  uid: number;
  folder: string;
  messageId: string;
  threadId: string;
  labels: string[];
  flags: string[];
  subject: string;
  from: ImapAddress[];
  to: ImapAddress[];
  date: string;
  text: string | null;
  /** An HTML body, used when `text` is null (an HTML-only message). */
  html?: string | null;
  /** Attachments : what the structure lists, and their decoded content. */
  attachments?: { part: string; filename: string | null; mimeType: string; content: Buffer }[];
  /** What `X-GM-RAW` matches : a test-only list of query strings. */
  matches: string[];
  raw?: string;
}

export type FakeCall =
  | { op: 'session'; account: GmailAccount; options: GmailSessionOptions }
  | { op: 'mailboxes' }
  | { op: 'search'; path: string; query: ImapSearch }
  | { op: 'fetch'; path: string; uids: readonly number[]; bodyBytes: number | null }
  | { op: 'append'; path: string; message: string; flags: readonly string[] }
  | { op: 'store'; path: string; uids: readonly number[]; change: ImapStore }
  | { op: 'download'; path: string; uid: number; part: string; maxBytes: number }
  | { op: 'create'; segments: readonly string[] };

export interface FakeGmail extends GmailTransport {
  readonly calls: FakeCall[];
  readonly messages: FakeMessage[];
  folders: readonly ImapMailbox[];
  /** When set, every sign-in is refused. */
  refuseSignIn: boolean;
  /** Ops (other than the session) the test expects ; `[]` when nothing reached IMAP. */
  ops(): string[];
}

let nextUid = 1000;

export function message(
  partial: Partial<FakeMessage> & Pick<FakeMessage, 'messageId' | 'threadId'>,
): FakeMessage {
  nextUid += 1;
  return {
    uid: nextUid,
    folder: ALL,
    labels: ['\\Inbox'],
    flags: ['\\Seen'],
    subject: 'Hello',
    from: [{ name: 'Colleague', address: 'colleague@myorg.com' }],
    to: [{ name: null, address: 'me@myorg.com' }],
    date: '2026-10-20T10:00:00.000Z',
    text: 'Hi there',
    matches: [],
    ...partial,
  };
}

export function fakeGmail(messages: FakeMessage[] = []): FakeGmail {
  const calls: FakeCall[] = [];
  const fake: FakeGmail = {
    calls,
    messages,
    folders: FOLDERS,
    refuseSignIn: false,
    ops: () => calls.filter((c) => c.op !== 'session').map((c) => c.op),
    async session(account, options, work) {
      calls.push({ op: 'session', account, options });
      if (fake.refuseSignIn) {
        throw new UpstreamAuthError(`Gmail refused the IMAP sign-in of ${account.email}.`, 401);
      }
      return work(session);
    },
  };

  const inFolder = (path: string) =>
    messages.filter((m) => m.folder === path || (path === ALL && m.folder !== DRAFTS));

  const view = (m: FakeMessage, options: ImapFetchOptions): ImapMessage => {
    const { bodyBytes } = options;
    let body: ImapBody | null = null;
    if (bodyBytes !== null && m.text !== null) {
      const content = m.text.slice(0, bodyBytes);
      body = { type: 'text/plain', content, truncated: m.text.length > content.length };
    } else if (bodyBytes !== null && typeof m.html === 'string') {
      const cap = options.htmlBytes ?? bodyBytes;
      const content = m.html.slice(0, cap);
      body = { type: 'text/html', content, truncated: m.html.length > content.length };
    }
    const structure = bodyBytes !== null || options.structure === true;
    return {
      uid: m.uid,
      messageId: m.messageId,
      threadId: m.threadId,
      labels: [...m.labels],
      flags: [...m.flags],
      date: m.date,
      subject: m.subject,
      from: m.from,
      to: m.to,
      cc: [],
      body,
      attachments: structure
        ? (m.attachments ?? []).map((a) => ({
            part: a.part,
            filename: a.filename,
            mimeType: a.mimeType,
            size: a.content.length,
          }))
        : [],
    };
  };

  const session: GmailImapSession = {
    async mailboxes() {
      calls.push({ op: 'mailboxes' });
      return fake.folders;
    },
    async search(path, query) {
      calls.push({ op: 'search', path, query });
      const pool = inFolder(path);
      const found =
        'gmailRaw' in query
          ? pool.filter((m) => m.matches.includes(query.gmailRaw))
          : 'threadId' in query
            ? pool.filter((m) => m.threadId === query.threadId)
            : 'messageId' in query
              ? pool.filter((m) => m.messageId === query.messageId)
              : pool;
      return found.map((m) => m.uid).sort((a, b) => a - b);
    },
    async fetch(path, uids, options) {
      calls.push({ op: 'fetch', path, uids, bodyBytes: options.bodyBytes });
      return inFolder(path)
        .filter((m) => uids.includes(m.uid))
        .map((m) => view(m, options));
    },
    async append(path, raw, flags) {
      calls.push({ op: 'append', path, message: raw, flags });
      const m = message({
        messageId: String(9_000_000_000_000_000_000n + BigInt(messages.length)),
        threadId: String(9_100_000_000_000_000_000n + BigInt(messages.length)),
        folder: path,
        flags: [...flags],
        labels: [],
        raw,
      });
      messages.push(m);
      return m.uid;
    },
    async download(path, uid, part, maxBytes) {
      calls.push({ op: 'download', path, uid, part, maxBytes });
      const m = inFolder(path).find((x) => x.uid === uid);
      const a = m?.attachments?.find((x) => x.part === part);
      if (!a) return null;
      return {
        content: a.content.subarray(0, maxBytes),
        truncated: a.content.length > maxBytes,
      };
    },
    async createMailbox(segments) {
      calls.push({ op: 'create', segments });
      const path = segments.join('/');
      if (fake.folders.some((f) => f.path === path)) return { path, created: false };
      fake.folders = [
        ...fake.folders,
        { path, specialUse: null, selectable: true, parentPath: segments.slice(0, -1).join('/') },
      ];
      return { path, created: true };
    },
    async store(path, uids, change) {
      calls.push({ op: 'store', path, uids, change });
      for (const m of inFolder(path).filter((x) => uids.includes(x.uid))) {
        const apply = (list: string[], values: readonly string[] | undefined) => {
          for (const v of values ?? []) {
            const i = list.indexOf(v);
            if (change.op === 'add' && i < 0) list.push(v);
            if (change.op === 'remove' && i >= 0) list.splice(i, 1);
          }
        };
        apply(m.labels, change.labels);
        apply(m.flags, change.flags);
      }
    },
  };
  return fake;
}
