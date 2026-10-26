/**
 * Execution, verification and resource discovery of the `gmail` provider,
 * over IMAP.
 *
 * Spec : docs/spec/vaubaan-gateway.md §2.4, §5, §7.2.
 * ADR  : docs/decisions/gmail-over-imap-with-an-app-password.md (D2) ;
 *        docs/decisions/plugin-identifiers-one-grammar-for-classify-and-execute.md.
 * Handbook : docs/handbook/providers/gmail.md, "Execution".
 *
 * `execute` takes its ids and labels from the classifier's grammar functions
 * only (`gmailId`, `writableLabel`) and its recipients from the same parser
 * (`collectRecipients`), checks that the mission's mailbox is the mailbox of
 * the credential, then runs the call in one IMAP session. Folders are found
 * by their SPECIAL-USE (`\All`, `\Drafts`), never by name. Ids leave as the
 * lower-case hexadecimal of `X-GM-THRID` / `X-GM-MSGID`, as the Gmail API
 * prints them. Nothing is ever sent : a draft is appended to `\Drafts`.
 *
 * No `ctx.fetch` here : the upstream is IMAP, injected as a `GmailTransport`
 * (`createGmailRuntime({ transport })`) so tests never open a socket.
 */

import type {
  ApiKeyCredentialSpec,
  ConnectionContext,
  CredentialCheck,
  ExecuteContext,
  McpToolResult,
  Resource,
} from '@vaubaan/plugin-sdk';

import { collectRecipients, type EmailAddress } from './address.ts';
import {
  creatableLabel,
  gmailId,
  gmailPartId,
  readMailboxMetadata,
  selectMailbox,
  SYSTEM_LABEL_IDS,
  writableLabel,
} from './classify.ts';
import {
  GMAIL_PLUGIN_ID,
  gmailAccount,
  gmailCredentialFields,
  type GmailAccount,
} from './credential.ts';
import { buildDraft, draftProblem, hasControlCharacter } from './draft.ts';
import { htmlToText, MAX_HTML_BYTES } from './html.ts';
import { GMAIL_CLASSIFIED_TOOLS } from './tools.ts';
import {
  imapflowTransport,
  type GmailImapSession,
  type GmailTransport,
  type ImapAddress,
  type ImapAttachment,
  type ImapBody,
  type ImapMailbox,
  type ImapMessage,
  type ImapStore,
} from './transport.ts';

export { GMAIL_PLUGIN_ID };

// ─── Bounds ────────────────────────────────────────────────────────────────

/** Deadline of one IMAP session, sign-in included. */
export const SESSION_TIMEOUT_MS = 60_000;
/** Default and largest `max_results` of `search_threads`. */
export const DEFAULT_MAX_RESULTS = 10;
export const MAX_MAX_RESULTS = 50;
/** Messages a search reads, newest first, to group into threads. */
export const MAX_SEARCH_SCAN = 500;
const SEARCH_BATCH = 50;
/** Longest query passed to `X-GM-RAW`. */
export const MAX_QUERY_LENGTH = 2000;
/** Newest messages of a thread returned by `get_thread`. */
export const MAX_THREAD_MESSAGES = 50;
/** Bytes of the text/plain part read per message. */
export const MAX_TEXT_BYTES = 20_000;
/** Newest drafts returned by `list_drafts`. */
export const MAX_DRAFTS = 50;
/** Largest attachment `get_attachment` returns, decoded, in bytes (5 MiB ; base64 adds a third). */
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

// ─── Ids ───────────────────────────────────────────────────────────────────

const MAX_U64 = (1n << 64n) - 1n;

/** IMAP's decimal `X-GM-THRID` / `X-GM-MSGID` → the Gmail API's lower-case hexadecimal. */
export function imapIdToHex(decimal: string): string {
  return BigInt(decimal).toString(16);
}

/** A hexadecimal id the grammar accepted → IMAP's decimal ; `null` beyond 64 bits. */
export function hexToImapId(hex: string): string | null {
  const value = BigInt(`0x${hex}`);
  return value <= MAX_U64 ? value.toString(10) : null;
}

// ─── Labels ────────────────────────────────────────────────────────────────

/** The system labels execute writes, as IMAP names them ; `UNREAD` is the absence of `\Seen`. */
const SYSTEM_TO_IMAP: Readonly<Record<string, string>> = {
  INBOX: '\\Inbox',
  STARRED: '\\Starred',
  IMPORTANT: '\\Important',
};
const UNREAD = 'UNREAD';
const SEEN = '\\Seen';

/** IMAP label names → the Gmail API's system ids, for what execute returns. */
const IMAP_TO_SYSTEM: Readonly<Record<string, string>> = {
  '\\inbox': 'INBOX',
  '\\starred': 'STARRED',
  '\\important': 'IMPORTANT',
  '\\sent': 'SENT',
  '\\draft': 'DRAFT',
};

function labelsOf(message: ImapMessage): string[] {
  const out = message.labels.map((l) => IMAP_TO_SYSTEM[l.toLowerCase()] ?? l);
  if (!message.flags.includes(SEEN)) out.push(UNREAD);
  return out;
}

/** The user labels : selectable folders without a special use, outside the system container. */
export function userLabels(mailboxes: readonly ImapMailbox[]): string[] {
  // Gmail's system folders live under one container (`[Gmail]`, `[Google Mail]`),
  // found as the parent of the `\All` folder, never by its name.
  const all = mailboxes.find((m) => m.specialUse === '\\All');
  const container = all && all.parentPath !== '' ? all.parentPath : null;
  return mailboxes
    .filter((m) => m.selectable && m.specialUse === null)
    .filter((m) => m.path.toUpperCase() !== 'INBOX')
    .filter(
      (m) => container === null || (m.path !== container && !m.path.startsWith(`${container}/`)),
    )
    .map((m) => m.path);
}

// ─── Results ───────────────────────────────────────────────────────────────

function ok(payload: Record<string, unknown>): McpToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload };
}

function fail(code: string, message: string): McpToolResult {
  const payload = { error: code, message: `gmail: ${message}` };
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: true,
  };
}

/** A refusal decided inside a session : it ends the session and becomes a tool error. */
class GmailToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'GmailToolError';
  }
}

const formatAddress = (a: ImapAddress): string | null =>
  a.address === null ? null : a.name ? `${a.name} <${a.address}>` : a.address;

const addressList = (list: readonly ImapAddress[]): string[] =>
  list.map(formatAddress).filter((a): a is string => a !== null);

/** The text of a body : as it is for text/plain, converted for text/html, capped either way. */
function textOf(body: ImapBody | null): Record<string, unknown> {
  if (body === null) return { text: null, text_format: null, text_truncated: false };
  if (body.type === 'text/plain') {
    return { text: body.content, text_format: 'plain', text_truncated: body.truncated };
  }
  const converted = htmlToText(body.content, MAX_TEXT_BYTES);
  return {
    text: converted.text,
    text_format: 'html',
    text_truncated: body.truncated || converted.truncated,
  };
}

const attachmentView = (a: ImapAttachment): Record<string, unknown> => ({
  part: a.part,
  filename: a.filename,
  mime_type: a.mimeType,
  size: a.size,
});

function messageView(m: ImapMessage, withText: boolean): Record<string, unknown> {
  return {
    id: imapIdToHex(m.messageId),
    thread_id: imapIdToHex(m.threadId),
    date: m.date,
    from: addressList(m.from),
    to: addressList(m.to),
    cc: addressList(m.cc),
    subject: m.subject,
    labels: labelsOf(m),
    ...(withText ? { ...textOf(m.body), attachments: m.attachments.map(attachmentView) } : {}),
  };
}

// ─── Folders ───────────────────────────────────────────────────────────────

async function folder(session: GmailImapSession, specialUse: '\\All' | '\\Drafts') {
  const found = (await session.mailboxes()).find((m) => m.specialUse === specialUse);
  if (!found) {
    throw new GmailToolError(
      'folder_not_found',
      `the mailbox has no ${specialUse} folder over IMAP; in Gmail's settings, under Labels, "Show in IMAP" must be on for ${specialUse === '\\All' ? 'All Mail' : 'Drafts'}.`,
    );
  }
  return found.path;
}

// ─── Tools ─────────────────────────────────────────────────────────────────
//
// Each tool checks every argument first and returns either the refusal or the
// work to do in a session : a call refused here opens no IMAP connection.

type Work = (session: GmailImapSession) => Promise<McpToolResult>;
type Plan = McpToolResult | Work;

const isWork = (plan: Plan): plan is Work => typeof plan === 'function';

function planSearchThreads(args: Readonly<Record<string, unknown>>): Plan {
  const q = args.q;
  if (typeof q !== 'string' || q.trim().length === 0)
    return fail('invalid_argument', 'q: missing.');
  if (q.length > MAX_QUERY_LENGTH || hasControlCharacter(q)) {
    return fail('invalid_argument', 'q: too long, or holds a control character.');
  }
  const max = maxResultsOf(args.max_results);
  if (max === null) {
    return fail('invalid_argument', `max_results: an integer from 1 to ${MAX_MAX_RESULTS}.`);
  }
  return async (session) => {
    const all = await folder(session, '\\All');
    const uids = (await session.search(all, { gmailRaw: q })).slice(-MAX_SEARCH_SCAN).reverse();
    const threads = new Map<string, { latest: ImapMessage; count: number }>();
    for (let i = 0; i < uids.length && threads.size < max; i += SEARCH_BATCH) {
      const batch = await session.fetch(all, uids.slice(i, i + SEARCH_BATCH), {
        bodyBytes: null,
      });
      for (const m of [...batch].sort((a, b) => b.uid - a.uid)) {
        const seen = threads.get(m.threadId);
        if (seen) seen.count += 1;
        else if (threads.size < max) threads.set(m.threadId, { latest: m, count: 1 });
      }
    }
    return ok({
      threads: [...threads.values()].map(({ latest, count }) => ({
        id: imapIdToHex(latest.threadId),
        subject: latest.subject,
        from: addressList(latest.from),
        date: latest.date,
        labels: labelsOf(latest),
        matching_messages: count,
      })),
      scanned_messages: uids.length,
    });
  };
}

function maxResultsOf(value: unknown): number | null {
  if (value === undefined || value === null) return DEFAULT_MAX_RESULTS;
  return typeof value === 'number' && Number.isInteger(value) && value >= 1
    ? Math.min(value, MAX_MAX_RESULTS)
    : null;
}

/** An id of the grammar, as IMAP's decimal ; the refusal when it is missing, malformed or too large. */
function imapIdArg(
  args: Readonly<Record<string, unknown>>,
  key: string,
): { hex: string; decimal: string } | McpToolResult {
  const hex = gmailId(args[key]);
  if (hex === null) return fail('invalid_argument', `${key}: missing or malformed.`);
  const decimal = hexToImapId(hex);
  if (decimal === null) return fail('invalid_argument', `${key}: out of range.`);
  return { hex, decimal };
}

const isRefusal = (v: object): v is McpToolResult => 'content' in v;

/** The UIDs of a thread in `\All`. */
async function threadUids(
  session: GmailImapSession,
  all: string,
  id: { hex: string; decimal: string },
) {
  const uids = await session.search(all, { threadId: id.decimal });
  if (uids.length === 0) throw new GmailToolError('not_found', `no thread ${id.hex} in All Mail.`);
  return uids;
}

function planGetThread(args: Readonly<Record<string, unknown>>): Plan {
  const id = imapIdArg(args, 'id');
  if (isRefusal(id)) return id;
  return async (session) => {
    const all = await folder(session, '\\All');
    const uids = await threadUids(session, all, id);
    const newest = uids.slice(-MAX_THREAD_MESSAGES);
    const messages = [
      ...(await session.fetch(all, newest, {
        bodyBytes: MAX_TEXT_BYTES,
        htmlBytes: MAX_HTML_BYTES,
      })),
    ]
      .filter((m) => m.threadId === id.decimal)
      .sort((a, b) => a.uid - b.uid);
    return ok({
      id: id.hex,
      messages: messages.map((m) => messageView(m, true)),
      messages_in_thread: uids.length,
      truncated: uids.length > newest.length,
    });
  };
}

/** The UID of a message of a thread in `\All`, or the refusal. */
async function messageUid(
  session: GmailImapSession,
  all: string,
  thread: { hex: string; decimal: string },
  message: { hex: string; decimal: string },
): Promise<number> {
  const uids = await threadUids(session, all, thread);
  // The message must belong to the thread the call was classified on.
  const found = (await session.search(all, { messageId: message.decimal })).filter((uid) =>
    uids.includes(uid),
  );
  if (found.length === 0) {
    throw new GmailToolError('not_found', `no message ${message.hex} in thread ${thread.hex}.`);
  }
  return found[0]!;
}

function planGetAttachment(args: Readonly<Record<string, unknown>>): Plan {
  const thread = imapIdArg(args, 'thread_id');
  if (isRefusal(thread)) return thread;
  const message = imapIdArg(args, 'message_id');
  if (isRefusal(message)) return message;
  const part = gmailPartId(args.part);
  if (part === null) return fail('invalid_argument', 'part: missing or malformed.');
  const tooLarge = (size: string) =>
    fail(
      'too_large',
      `attachment ${part} is ${size}; get_attachment returns at most ${MAX_ATTACHMENT_BYTES} bytes (5 MiB).`,
    );
  return async (session) => {
    const all = await folder(session, '\\All');
    const uid = await messageUid(session, all, thread, message);
    const [fetched] = await session.fetch(all, [uid], { bodyBytes: null, structure: true });
    const attachment = fetched?.attachments.find((a) => a.part === part);
    if (!attachment) {
      return fail(
        'not_found',
        `message ${message.hex} has no attachment ${part} (get_thread lists them).`,
      );
    }
    if (attachment.size > MAX_ATTACHMENT_BYTES) return tooLarge(`about ${attachment.size} bytes`);
    const content = await session.download(all, uid, part, MAX_ATTACHMENT_BYTES);
    if (content === null) return fail('not_found', `attachment ${part} could not be read.`);
    if (content.truncated) return tooLarge(`larger than ${MAX_ATTACHMENT_BYTES} bytes`);
    return ok({
      thread_id: thread.hex,
      message_id: message.hex,
      part,
      filename: attachment.filename,
      mime_type: attachment.mimeType,
      size: content.content.length,
      content_base64: content.content.toString('base64'),
    });
  };
}

const sameName = (a: string, b: string): boolean =>
  a.normalize('NFC').toLowerCase() === b.normalize('NFC').toLowerCase();

function planCreateLabel(args: Readonly<Record<string, unknown>>): Plan {
  const label = creatableLabel(args.name);
  if (label === null) {
    return fail(
      'invalid_argument',
      'name: missing or malformed, a system label, TRASH or SPAM, or under [Gmail]/.',
    );
  }
  return async (session) => {
    const mailboxes = await session.mailboxes();
    const all = mailboxes.find((m) => m.specialUse === '\\All');
    const container = all && all.parentPath !== '' ? all.parentPath : null;
    const clash = mailboxes.find((m) => sameName(m.path, label));
    if (clash && clash.specialUse !== null) {
      return fail('invalid_argument', `'${label}' is a system folder of the mailbox.`);
    }
    if (clash) return fail('already_exists', `label '${clash.path}' already exists.`);
    if (
      container !== null &&
      (sameName(label, container) || label.toLowerCase().startsWith(`${container.toLowerCase()}/`))
    ) {
      return fail('invalid_argument', `'${label}' is under the system folders of the mailbox.`);
    }
    const created = await session.createMailbox(label.split('/'));
    if (!created.created) return fail('already_exists', `label '${created.path}' already exists.`);
    return ok({ label: created.path, created: true });
  };
}

const listDrafts: Work = async (session) => {
  const drafts = await folder(session, '\\Drafts');
  const uids = (await session.search(drafts, { all: true })).slice(-MAX_DRAFTS);
  const messages = [...(await session.fetch(drafts, uids, { bodyBytes: null }))].sort(
    (a, b) => b.uid - a.uid,
  );
  return ok({ drafts: messages.map((m) => messageView(m, false)) });
};

/** Recipients of one field, with the classifier's parser ; the refusal when one does not parse. */
function recipientsOf(
  args: Readonly<Record<string, unknown>>,
  field: 'to' | 'cc' | 'bcc',
): readonly EmailAddress[] | McpToolResult {
  const collected = collectRecipients({ [field]: args[field] });
  return 'denied' in collected ? fail('invalid_argument', collected.denied) : collected.recipients;
}

function planCreateDraft(
  account: GmailAccount,
  args: Readonly<Record<string, unknown>>,
  now: () => Date,
): Plan {
  const to = recipientsOf(args, 'to');
  if (!Array.isArray(to)) return to as McpToolResult;
  const cc = recipientsOf(args, 'cc');
  if (!Array.isArray(cc)) return cc as McpToolResult;
  const bcc = recipientsOf(args, 'bcc');
  if (!Array.isArray(bcc)) return bcc as McpToolResult;
  const problem = draftProblem(args.subject, args.body);
  if (problem !== null) return fail('invalid_argument', problem);
  const message = buildDraft({
    from: account.email,
    to,
    cc,
    bcc,
    subject: args.subject as string,
    body: args.body as string,
    date: now(),
  });
  return async (session) => {
    const drafts = await folder(session, '\\Drafts');
    const uid = await session.append(drafts, message, ['\\Draft', SEEN]);
    const stored = uid === null ? [] : await session.fetch(drafts, [uid], { bodyBytes: null });
    const draft = stored[0];
    return ok({
      draft: draft
        ? { id: imapIdToHex(draft.messageId), thread_id: imapIdToHex(draft.threadId) }
        : null,
      sent: false,
    });
  };
}

const listLabels: Work = async (session) => {
  const user = userLabels(await session.mailboxes());
  return ok({
    labels: [
      ...[...Object.keys(SYSTEM_TO_IMAP), UNREAD].map((id) => ({ id, name: id, type: 'system' })),
      ...user.map((name) => ({ id: name, name, type: 'user' })),
    ],
  });
};

/** What a label write stores : a label of `X-GM-LABELS`, or `\Seen` for `UNREAD`. */
async function labelChange(
  session: GmailImapSession,
  label: string,
  adding: boolean,
): Promise<ImapStore> {
  const op = adding ? 'add' : 'remove';
  if (label === UNREAD) return { op: adding ? 'remove' : 'add', flags: [SEEN] };
  const system = SYSTEM_TO_IMAP[label];
  if (system !== undefined) return { op, labels: [system] };
  // A user label must exist and be one : a STORE would create a missing label, and
  // a folder with a special use is a system folder under a localized name. The name
  // stored is the server's own spelling of it.
  const wanted = label.normalize('NFC');
  const listed = userLabels(await session.mailboxes()).find((l) => l.normalize('NFC') === wanted);
  if (listed === undefined) {
    throw new GmailToolError(
      'not_found',
      `no user label '${label}' (list_labels gives the names).`,
    );
  }
  return { op, labels: [listed] };
}

function planLabelWrite(tool: string, args: Readonly<Record<string, unknown>>): Plan {
  const thread = imapIdArg(args, 'thread_id');
  if (isRefusal(thread)) return thread;
  const label = writableLabel(args.label);
  if (label === null) return fail('invalid_argument', 'label: missing, malformed, TRASH or SPAM.');
  if (SYSTEM_LABEL_IDS.has(label) && SYSTEM_TO_IMAP[label] === undefined && label !== UNREAD) {
    return fail('unsupported_label', `label ${label} cannot be written over IMAP.`);
  }
  const onMessage = tool === 'gmail__label_message' || tool === 'gmail__unlabel_message';
  const adding = tool === 'gmail__label_message' || tool === 'gmail__label_thread';
  let message: { hex: string; decimal: string } | null = null;
  if (onMessage) {
    const parsed = imapIdArg(args, 'message_id');
    if (isRefusal(parsed)) return parsed;
    message = parsed;
  }
  return async (session) => {
    const all = await folder(session, '\\All');
    const change = await labelChange(session, label, adding);
    const uids =
      message !== null
        ? [await messageUid(session, all, thread, message)]
        : await threadUids(session, all, thread);
    await session.store(all, uids, change);
    return ok({
      thread_id: thread.hex,
      ...(message !== null ? { message_id: message.hex } : {}),
      label,
      action: adding ? 'added' : 'removed',
      messages: uids.length,
    });
  };
}

function planOf(
  tool: string,
  args: Readonly<Record<string, unknown>>,
  account: GmailAccount,
  now: () => Date,
): Plan {
  switch (tool) {
    case 'gmail__search_threads':
      return planSearchThreads(args);
    case 'gmail__get_thread':
      return planGetThread(args);
    case 'gmail__get_attachment':
      return planGetAttachment(args);
    case 'gmail__create_label':
      return planCreateLabel(args);
    case 'gmail__list_drafts':
      return listDrafts;
    case 'gmail__create_draft':
      return planCreateDraft(account, args, now);
    case 'gmail__list_labels':
      return listLabels;
    default:
      return planLabelWrite(tool, args);
  }
}

// ─── Runtime ───────────────────────────────────────────────────────────────

export interface GmailRuntimeOptions {
  /** Defaults to the real `imapflow` transport. */
  readonly transport?: GmailTransport;
  /** The clock a draft is dated with ; tests pin it. */
  readonly now?: () => Date;
}

export interface GmailRuntime {
  execute(
    ctx: ExecuteContext,
    tool: string,
    args: Readonly<Record<string, unknown>>,
  ): Promise<McpToolResult>;
  discoverResources(ctx: ConnectionContext): Promise<readonly Resource[]>;
  verify(ctx: ConnectionContext): Promise<CredentialCheck>;
  /** The credential spec, its `verify` bound to this transport. */
  readonly credential: ApiKeyCredentialSpec;
}

/** The mailbox as the connection's single resource. */
export function mailboxResource(email: string): Resource {
  return {
    provider: GMAIL_PLUGIN_ID,
    ref: email,
    displayName: email,
    metadata: { account_email: email },
  };
}

export function createGmailRuntime(options: GmailRuntimeOptions = {}): GmailRuntime {
  const transport = options.transport ?? imapflowTransport;
  const now = options.now ?? (() => new Date());

  const inSession = <T>(
    account: GmailAccount,
    ctx: ConnectionContext,
    work: (s: GmailImapSession) => Promise<T>,
  ): Promise<T> =>
    transport.session(
      account,
      {
        timeoutMs: SESSION_TIMEOUT_MS,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
        ...(ctx.logger ? { logger: ctx.logger } : {}),
      },
      work,
    );

  /** Signs in and checks the two folders every tool needs. */
  const signIn = async (ctx: ConnectionContext): Promise<GmailAccount> => {
    const account = gmailAccount(ctx.credential);
    await inSession(account, ctx, async (s) => {
      await folder(s, '\\All');
      await folder(s, '\\Drafts');
    });
    return account;
  };

  const verify = async (ctx: ConnectionContext): Promise<CredentialCheck> => {
    const account = await signIn(ctx);
    return { account: account.email, expiresAt: null };
  };

  return {
    credential: { ...gmailCredentialFields, verify },
    verify,

    async discoverResources(ctx) {
      const account = await signIn(ctx);
      return [mailboxResource(account.email)];
    },

    async execute(ctx, tool, args) {
      if (!(GMAIL_CLASSIFIED_TOOLS as readonly string[]).includes(tool)) {
        return fail('unknown_tool', `unknown tool '${tool}'.`);
      }
      const mailbox = selectMailbox(ctx.resources);
      if ('denied' in mailbox) return fail('invalid_resource', mailbox.denied);
      if (tool === 'gmail__describe_zones') {
        return ok({ mailbox: mailbox.ref, zones: readMailboxMetadata(mailbox) });
      }
      const account = gmailAccount(ctx.credential);
      if (mailbox.ref.toLowerCase() !== account.email) {
        return fail(
          'invalid_resource',
          `mailbox '${mailbox.ref}' is not the mailbox of this connection.`,
        );
      }
      try {
        const plan = planOf(tool, args, account, now);
        if (!isWork(plan)) return plan;
        return await inSession(account, ctx, plan);
      } catch (err) {
        if (err instanceof GmailToolError) return fail(err.code, err.message);
        throw err;
      }
    },
  };
}
