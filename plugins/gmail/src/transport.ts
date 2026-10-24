/**
 * IMAP transport of the `gmail` provider : one connection per call to
 * `imap.gmail.com:993` (implicit TLS), signed in with the app password,
 * through `imapflow`.
 *
 * Spec : docs/spec/vaubaan-gateway.md §2.4 (the credential is used for one
 *        call and never returned), §5.
 * ADR  : docs/decisions/gmail-over-imap-with-an-app-password.md (D2).
 *
 * The transport is an interface so `execute`, `verify` and
 * `discoverResources` are tested without a network :
 * `createGmailPlugin({ transport })` takes a fake. Rules of the real one :
 *   - one session is one connection : opened, used by `work`, logged out ;
 *   - a refused sign-in is an `UpstreamAuthError` (the host marks the
 *     connection "needs reconnecting" ; the owner pastes a new app password) ;
 *   - the caller's `AbortSignal` and the session deadline close the
 *     connection and reject with a plain `Error` ;
 *   - a mailbox's special use is the one the server reports (SPECIAL-USE),
 *     never one guessed from its name : Gmail localizes its folder names ;
 *   - ids cross this interface as the decimal strings IMAP uses
 *     (`X-GM-THRID`, `X-GM-MSGID`) ; `execute.ts` converts them.
 */

import {
  ImapFlow,
  type FetchMessageObject,
  type ImapFlowOptions,
  type MessageStructureObject,
} from 'imapflow';

import { UpstreamAuthError, type PluginLogger } from '@vaubaan/plugin-sdk';

import { GMAIL_IMAP_HOST, GMAIL_IMAP_PORT, type GmailAccount } from './credential.ts';

// ─── The interface execute uses ────────────────────────────────────────────

export interface ImapMailbox {
  /** The full path, as the server lists it (`[Gmail]/Tous les messages`). */
  readonly path: string;
  /** The SPECIAL-USE attribute the server reports (`\All`, `\Drafts`…), or `null`. */
  readonly specialUse: string | null;
  /** False for a container that cannot be selected (`\Noselect`). */
  readonly selectable: boolean;
  /** The path of the parent, `''` at the top level. */
  readonly parentPath: string;
}

export interface ImapAddress {
  readonly name: string | null;
  readonly address: string | null;
}

export interface ImapMessage {
  readonly uid: number;
  /** `X-GM-MSGID`, decimal. */
  readonly messageId: string;
  /** `X-GM-THRID`, decimal. */
  readonly threadId: string;
  /** `X-GM-LABELS`, as the server sends them (`\Inbox`, `\Important`, `Legal/Contracts`). */
  readonly labels: readonly string[];
  readonly flags: readonly string[];
  /** ISO-8601, the internal date ; `null` when the server sent none. */
  readonly date: string | null;
  readonly subject: string | null;
  readonly from: readonly ImapAddress[];
  readonly to: readonly ImapAddress[];
  readonly cc: readonly ImapAddress[];
  /** The text/plain part, decoded, at most the requested bytes ; `null` when not asked or absent. */
  readonly text: string | null;
  readonly textTruncated: boolean;
}

/** What a search selects : Gmail's own syntax, a thread, a message, or every message. */
export type ImapSearch =
  | { readonly gmailRaw: string }
  | { readonly threadId: string }
  | { readonly messageId: string }
  | { readonly all: true };

export interface ImapFetchOptions {
  /** Bytes of the text/plain part to read per message ; `null` reads no body. */
  readonly bodyBytes: number | null;
}

/** A change of labels (`X-GM-LABELS`) or of flags. */
export interface ImapStore {
  readonly op: 'add' | 'remove';
  readonly labels?: readonly string[];
  readonly flags?: readonly string[];
}

/** One signed-in connection. Every method opens the mailbox it names. */
export interface GmailImapSession {
  mailboxes(): Promise<readonly ImapMailbox[]>;
  /** UIDs in ascending order. */
  search(path: string, query: ImapSearch): Promise<readonly number[]>;
  fetch(
    path: string,
    uids: readonly number[],
    options: ImapFetchOptions,
  ): Promise<readonly ImapMessage[]>;
  /** The UID of the new message when the server says it (UIDPLUS), else `null`. */
  append(path: string, message: string, flags: readonly string[]): Promise<number | null>;
  store(path: string, uids: readonly number[], change: ImapStore): Promise<void>;
}

export interface GmailSessionOptions {
  /** Whole-session deadline : connection, sign-in and work. */
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly logger?: PluginLogger;
}

export interface GmailTransport {
  /** Signs in, runs `work`, logs out. Throws `UpstreamAuthError` when the sign-in is refused. */
  session<T>(
    account: GmailAccount,
    options: GmailSessionOptions,
    work: (session: GmailImapSession) => Promise<T>,
  ): Promise<T>;
}

// ─── Bounds ────────────────────────────────────────────────────────────────

/** Budget of the TCP and TLS handshake. */
export const CONNECT_TIMEOUT_MS = 10_000;
/** Budget of the server's greeting. */
export const GREETING_TIMEOUT_MS = 10_000;
/** Silence after which the socket is given up. */
export const SOCKET_TIMEOUT_MS = 30_000;
/** Largest single response line or literal accepted from the server. */
export const MAX_LITERAL_BYTES = 8 * 1024 * 1024;

// ─── The real transport ────────────────────────────────────────────────────

/** The session was cut short by the caller's signal or by its deadline. */
export class GmailSessionStopped extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GmailSessionStopped';
  }
}

interface ImapError extends Error {
  readonly authenticationFailed?: boolean;
  readonly responseText?: string;
  readonly code?: string;
}

/** A short, single-line rendering of the server's own words, for an operator. */
function serverWords(err: ImapError): string {
  const text = (err.responseText ?? '').replace(/[^\x20-\x7e]/g, ' ').trim();
  return text.length > 0 ? ` (${text.slice(0, 200)})` : '';
}

function humanize(err: unknown, account: GmailAccount): Error {
  const e = err as ImapError;
  if (e?.authenticationFailed === true) {
    return new UpstreamAuthError(
      `Gmail refused the IMAP sign-in of ${account.email}${serverWords(e)}: the app password is wrong or was revoked, app passwords are turned off for the account, or IMAP is off in its Gmail settings.`,
      401,
    );
  }
  const message = e instanceof Error ? e.message : String(err);
  if (/ENOTFOUND|EAI_AGAIN/.test(message) || e?.code === 'ENOTFOUND') {
    return new Error(`gmail: ${GMAIL_IMAP_HOST} cannot be resolved.`);
  }
  if (/ECONNREFUSED|ECONNRESET/.test(message)) {
    return new Error(`gmail: the connection to ${GMAIL_IMAP_HOST} was refused or reset.`);
  }
  if (/timeout|timed out|ETIMEDOUT/i.test(message) || e?.code === 'CONNECT_TIMEOUT') {
    return new Error(`gmail: ${GMAIL_IMAP_HOST} did not answer in time.`);
  }
  return e instanceof Error ? e : new Error(message);
}

const decimal = (value: unknown): string | null =>
  typeof value === 'string' && /^[0-9]{1,20}$/.test(value)
    ? value
    : typeof value === 'bigint'
      ? value.toString(10)
      : null;

const addresses = (list: readonly { name?: string; address?: string }[] | undefined) =>
  (list ?? []).map((a) => ({ name: a.name ?? null, address: a.address ?? null }));

/** The first text/plain part that is not an attachment, as a part number to download. */
export function textPartOf(node: MessageStructureObject | undefined): string | null {
  if (!node) return null;
  if (node.childNodes && node.childNodes.length > 0) {
    for (const child of node.childNodes) {
      const found = textPartOf(child);
      if (found !== null) return found;
    }
    return null;
  }
  if (node.type?.toLowerCase() !== 'text/plain') return null;
  if (node.disposition?.toLowerCase() === 'attachment') return null;
  // A message that is a single part has no part number : its body is part 1.
  return node.part ?? '1';
}

async function readCapped(
  stream: AsyncIterable<Buffer | string>,
  cap: number,
): Promise<{ text: string; truncated: boolean }> {
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  for await (const chunk of stream) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    if (size + buf.length > cap) {
      chunks.push(buf.subarray(0, cap - size));
      size = cap;
      truncated = true;
      break;
    }
    chunks.push(buf);
    size += buf.length;
  }
  return { text: Buffer.concat(chunks).toString('utf8'), truncated };
}

class ImapflowSession implements GmailImapSession {
  constructor(private readonly client: ImapFlow) {}

  async mailboxes(): Promise<readonly ImapMailbox[]> {
    const listed = await this.client.list();
    return listed.map((m) => ({
      path: m.path,
      // A special use guessed from a localized name is not the server's word.
      specialUse: m.specialUseSource === 'extension' && m.specialUse ? m.specialUse : null,
      selectable: !m.flags.has('\\Noselect'),
      parentPath: m.parentPath ?? '',
    }));
  }

  async search(path: string, query: ImapSearch): Promise<readonly number[]> {
    const lock = await this.client.getMailboxLock(path, { readOnly: true });
    try {
      const criteria =
        'gmailRaw' in query
          ? { gmraw: query.gmailRaw }
          : 'threadId' in query
            ? { threadId: query.threadId }
            : 'messageId' in query
              ? { emailId: query.messageId }
              : { all: true };
      const found = await this.client.search(criteria, { uid: true });
      return Array.isArray(found) ? [...found].sort((a, b) => a - b) : [];
    } finally {
      lock.release();
    }
  }

  async fetch(
    path: string,
    uids: readonly number[],
    options: ImapFetchOptions,
  ): Promise<readonly ImapMessage[]> {
    if (uids.length === 0) return [];
    const lock = await this.client.getMailboxLock(path, { readOnly: true });
    try {
      const fetched: FetchMessageObject[] = await this.client.fetchAll(
        [...uids],
        {
          uid: true,
          envelope: true,
          flags: true,
          labels: true,
          threadId: true,
          internalDate: true,
          bodyStructure: options.bodyBytes !== null,
        },
        { uid: true },
      );
      const out: ImapMessage[] = [];
      // Downloads run after the fetch completes : no command inside a fetch.
      for (const m of fetched) {
        const messageId = decimal(m.emailId);
        const threadId = decimal(m.threadId);
        if (messageId === null || threadId === null) continue;
        let text: string | null = null;
        let textTruncated = false;
        const part = options.bodyBytes !== null ? textPartOf(m.bodyStructure) : null;
        if (part !== null && options.bodyBytes !== null) {
          const download = await this.client.download(String(m.uid), part, {
            uid: true,
            maxBytes: options.bodyBytes + 1,
          });
          if (download.content) {
            const read = await readCapped(download.content, options.bodyBytes);
            text = read.text;
            textTruncated = read.truncated;
          }
        }
        const date =
          m.internalDate instanceof Date && !Number.isNaN(m.internalDate.getTime())
            ? m.internalDate.toISOString()
            : null;
        out.push({
          uid: m.uid,
          messageId,
          threadId,
          labels: [...(m.labels ?? [])],
          flags: [...(m.flags ?? [])],
          date,
          subject: m.envelope?.subject ?? null,
          from: addresses(m.envelope?.from),
          to: addresses(m.envelope?.to),
          cc: addresses(m.envelope?.cc),
          text,
          textTruncated,
        });
      }
      return out;
    } finally {
      lock.release();
    }
  }

  async append(path: string, message: string, flags: readonly string[]): Promise<number | null> {
    const result = await this.client.append(path, message, [...flags]);
    if (!result) throw new Error(`gmail: the server did not store the message in ${path}.`);
    return typeof result.uid === 'number' ? result.uid : null;
  }

  async store(path: string, uids: readonly number[], change: ImapStore): Promise<void> {
    if (uids.length === 0) return;
    const lock = await this.client.getMailboxLock(path);
    try {
      const range = [...uids];
      const apply = (values: string[], useLabels: boolean): Promise<boolean> =>
        change.op === 'add'
          ? this.client.messageFlagsAdd(range, values, { uid: true, useLabels })
          : this.client.messageFlagsRemove(range, values, { uid: true, useLabels });
      if (change.labels && change.labels.length > 0) await apply([...change.labels], true);
      if (change.flags && change.flags.length > 0) await apply([...change.flags], false);
    } finally {
      lock.release();
    }
  }
}

/** Builds the `imapflow` client of one session ; tests pass a fake. */
export type ImapClientFactory = (options: ImapFlowOptions) => ImapFlow;

/** The real transport over the given client factory : one client per session. */
export function createImapflowTransport(
  newClient: ImapClientFactory = (options) => new ImapFlow(options),
): GmailTransport {
  return {
    async session(account, options, work) {
      if (options.signal?.aborted) {
        throw new GmailSessionStopped('gmail: the call was aborted by the gateway.');
      }
      const client = newClient({
        host: GMAIL_IMAP_HOST,
        port: GMAIL_IMAP_PORT,
        secure: true,
        auth: { user: account.email, pass: account.appPassword },
        logger: false,
        disableAutoIdle: true,
        connectionTimeout: Math.min(CONNECT_TIMEOUT_MS, options.timeoutMs),
        greetingTimeout: Math.min(GREETING_TIMEOUT_MS, options.timeoutMs),
        socketTimeout: Math.min(SOCKET_TIMEOUT_MS, options.timeoutMs),
        maxLineLength: MAX_LITERAL_BYTES,
        maxLiteralSize: MAX_LITERAL_BYTES,
        clientInfo: { name: 'Vaubaan Gateway' },
      });
      // An 'error' event without a listener would crash the process.
      client.on('error', (err: Error) => {
        options.logger?.warn('gmail imap connection error', { error_class: err.name });
      });

      let stop: ((err: Error) => void) | null = null;
      const stopped = new Promise<never>((_resolve, reject) => {
        stop = reject;
      });
      const end = (reason: string) => () => {
        stop?.(new GmailSessionStopped(reason));
        client.close();
      };
      const onAbort = end('gmail: the call was aborted by the gateway.');
      const timer = setTimeout(
        end(`gmail: the IMAP session timed out after ${Math.round(options.timeoutMs / 1000)}s.`),
        options.timeoutMs,
      );
      options.signal?.addEventListener('abort', onAbort, { once: true });
      // `stopped` rejects only when the call is cut short; never left unobserved.
      stopped.catch(() => undefined);

      try {
        return await Promise.race([
          (async () => {
            try {
              await client.connect();
            } catch (err) {
              throw humanize(err, account);
            }
            const result = await work(new ImapflowSession(client));
            await client.logout();
            return result;
          })(),
          stopped,
        ]);
      } catch (err) {
        client.close();
        if (err instanceof UpstreamAuthError || err instanceof GmailSessionStopped) throw err;
        throw humanize(err, account);
      } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
      }
    },
  };
}

/** The real transport : one `imapflow` client per session. */
export const imapflowTransport: GmailTransport = createImapflowTransport();
