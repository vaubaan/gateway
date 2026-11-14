/**
 * Execution, verification and resource discovery of the `gmail` provider,
 * over IMAP, and over SMTP for the two sends.
 *
 * Spec : docs/spec/vaubaan-gateway.md §2.4, §5, §7.2.
 * ADR  : docs/decisions/gmail-over-imap-with-an-app-password.md (D2) ;
 *        docs/decisions/plugin-identifiers-one-grammar-for-classify-and-execute.md.
 * Handbook : docs/handbook/providers/gmail.md.
 *
 * `execute` takes its ids and labels from the classifier's grammar functions
 * only (`gmailId`, `writableLabel`) and its recipients from the same parser
 * (`collectRecipients`), checks that the mission's mailbox is the mailbox of
 * the credential, then runs the call in one IMAP session. Folders are found
 * by their SPECIAL-USE (`\All`, `\Drafts`), never by name. Ids leave as the
 * lower-case hexadecimal of `X-GM-THRID` / `X-GM-MSGID`, as the Gmail API
 * prints them. A draft is appended to `\Drafts` ; a send is relayed over
 * SMTP (`smtp.ts`) to the recipients checked here and to no other, and Gmail
 * files its copy in Sent (nothing is appended).
 *
 * No `ctx.fetch` here : the upstreams are IMAP and SMTP, injected as a
 * `GmailTransport` and a `GmailSmtpTransport`
 * (`createGmailRuntime({ transport, smtp })`) so tests never open a socket.
 */

import {
  declining,
  ExecutorRefusal,
  refusalResult,
  textResult,
  type ApiKeyCredentialSpec,
  type AccountContext,
  type CredentialCheck,
  type ExecuteContext,
  type McpToolResult,
  type Resource,
} from '@vaubaan/plugin-sdk';

import { collectRecipients, parseBareAddress, type EmailAddress } from './address.ts';
import {
  MAX_SEND_RECIPIENTS,
  creatableLabel,
  gmailId,
  gmailPartId,
  readMailboxMetadata,
  selectMailbox,
  SYSTEM_LABEL_IDS,
  writableLabel,
} from './classify.ts';
import { gmailAccount, gmailCredentialFields, type GmailAccount } from './credential.ts';
import { buildDraft, draftProblem, hasControlCharacter, withoutBccHeader } from './draft.ts';
import { htmlToText, MAX_HTML_BYTES } from './html.ts';
import {
  GmailSmtpError,
  nodemailerSmtpTransport,
  type GmailSmtpTransport,
  type SmtpMail,
  type SmtpReceipt,
} from './smtp.ts';
import { PROVIDER_ID, TOOL } from './identity.ts';
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
/** Largest draft `send_draft` relays, as stored (7 MiB : under the transport's 8 MiB literal cap). */
export const MAX_SENT_DRAFT_BYTES = 7 * 1024 * 1024;

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

/**
 * What a tool answers : the payload as JSON text, and as its machine-readable
 * twin (`structuredContent`), which the host forwards to the agent's client
 * as it is. The SDK's `jsonResult` has no twin.
 */
function structuredResult(payload: Record<string, unknown>): McpToolResult {
  return { ...textResult(JSON.stringify(payload)), structuredContent: payload };
}

/**
 * The text of a declined call : the plugin's code and its words, as JSON
 * (`{"error":"not_found","message":"gmail: …"}`). Agents and the handbook's
 * Debug section read the code.
 */
function refusalText(code: string, message: string): string {
  return JSON.stringify({ error: code, message: `gmail: ${message}` });
}

/** A declined call, as the result `execute` returns. */
function refused(code: string, message: string): McpToolResult {
  return refusalResult(refusalText(code, message));
}

/** A call declined inside a session : thrown, it ends the session ; `declining` returns it. */
function refusal(code: string, message: string): ExecutorRefusal {
  return new ExecutorRefusal(refusalText(code, message));
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

function messageView(m: ImapMessage, withText: boolean, withBcc = false): Record<string, unknown> {
  return {
    id: imapIdToHex(m.messageId),
    thread_id: imapIdToHex(m.threadId),
    date: m.date,
    from: addressList(m.from),
    to: addressList(m.to),
    cc: addressList(m.cc),
    ...(withBcc ? { bcc: addressList(m.bcc) } : {}),
    subject: m.subject,
    labels: labelsOf(m),
    ...(withText ? { ...textOf(m.body), attachments: m.attachments.map(attachmentView) } : {}),
  };
}

// ─── Folders ───────────────────────────────────────────────────────────────

async function folder(session: GmailImapSession, specialUse: '\\All' | '\\Drafts') {
  const found = (await session.mailboxes()).find((m) => m.specialUse === specialUse);
  if (!found) {
    throw refusal(
      'folder_not_found',
      `the mailbox has no ${specialUse} folder over IMAP; in Gmail's settings, under Labels, "Show in IMAP" must be on for ${specialUse === '\\All' ? 'All Mail' : 'Drafts'}.`,
    );
  }
  return found.path;
}

// ─── Tools ─────────────────────────────────────────────────────────────────
//
// Each tool checks every argument first and returns either the refusal or the
// work to do : a call refused here opens no IMAP and no SMTP connection.

/** Relays one message over SMTP, signed in as the account's mailbox. */
type SendMail = (mail: SmtpMail) => Promise<SmtpReceipt>;
/** Work in one IMAP session ; `send` opens an SMTP connection only when called. */
type Work = (session: GmailImapSession, send: SendMail) => Promise<McpToolResult>;
/** Work over SMTP alone : no IMAP session is opened. */
interface SmtpWork {
  readonly smtp: (send: SendMail) => Promise<McpToolResult>;
}
type Plan = McpToolResult | Work | SmtpWork;

const isWork = (plan: Plan): plan is Work => typeof plan === 'function';
const isSmtpWork = (plan: Plan): plan is SmtpWork => 'smtp' in plan;

function planSearchThreads(args: Readonly<Record<string, unknown>>): Plan {
  const q = args.q;
  if (typeof q !== 'string' || q.trim().length === 0)
    return refused('invalid_argument', 'q: missing.');
  if (q.length > MAX_QUERY_LENGTH || hasControlCharacter(q)) {
    return refused('invalid_argument', 'q: too long, or holds a control character.');
  }
  const max = maxResultsOf(args.max_results);
  if (max === null) {
    return refused('invalid_argument', `max_results: an integer from 1 to ${MAX_MAX_RESULTS}.`);
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
    return structuredResult({
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
  if (hex === null) return refused('invalid_argument', `${key}: missing or malformed.`);
  const decimal = hexToImapId(hex);
  if (decimal === null) return refused('invalid_argument', `${key}: out of range.`);
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
  if (uids.length === 0) throw refusal('not_found', `no thread ${id.hex} in All Mail.`);
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
    return structuredResult({
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
    throw refusal('not_found', `no message ${message.hex} in thread ${thread.hex}.`);
  }
  return found[0]!;
}

function planGetAttachment(args: Readonly<Record<string, unknown>>): Plan {
  const thread = imapIdArg(args, 'thread_id');
  if (isRefusal(thread)) return thread;
  const message = imapIdArg(args, 'message_id');
  if (isRefusal(message)) return message;
  const part = gmailPartId(args.part);
  if (part === null) return refused('invalid_argument', 'part: missing or malformed.');
  const tooLarge = (size: string) =>
    refused(
      'too_large',
      `attachment ${part} is ${size}; get_attachment returns at most ${MAX_ATTACHMENT_BYTES} bytes (5 MiB).`,
    );
  return async (session) => {
    const all = await folder(session, '\\All');
    const uid = await messageUid(session, all, thread, message);
    const [fetched] = await session.fetch(all, [uid], { bodyBytes: null, structure: true });
    const attachment = fetched?.attachments.find((a) => a.part === part);
    if (!attachment) {
      return refused(
        'not_found',
        `message ${message.hex} has no attachment ${part} (get_thread lists them).`,
      );
    }
    if (attachment.size > MAX_ATTACHMENT_BYTES) return tooLarge(`about ${attachment.size} bytes`);
    const content = await session.download(all, uid, part, MAX_ATTACHMENT_BYTES);
    if (content === null) return refused('not_found', `attachment ${part} could not be read.`);
    if (content.truncated) return tooLarge(`larger than ${MAX_ATTACHMENT_BYTES} bytes`);
    return structuredResult({
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
    return refused(
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
      return refused('invalid_argument', `'${label}' is a system folder of the mailbox.`);
    }
    if (clash) return refused('already_exists', `label '${clash.path}' already exists.`);
    if (
      container !== null &&
      (sameName(label, container) || label.toLowerCase().startsWith(`${container.toLowerCase()}/`))
    ) {
      return refused('invalid_argument', `'${label}' is under the system folders of the mailbox.`);
    }
    const created = await session.createMailbox(label.split('/'));
    if (!created.created)
      return refused('already_exists', `label '${created.path}' already exists.`);
    return structuredResult({ label: created.path, created: true });
  };
}

const listDrafts: Work = async (session) => {
  const drafts = await folder(session, '\\Drafts');
  const uids = (await session.search(drafts, { all: true })).slice(-MAX_DRAFTS);
  const messages = [...(await session.fetch(drafts, uids, { bodyBytes: null }))].sort(
    (a, b) => b.uid - a.uid,
  );
  return structuredResult({ drafts: messages.map((m) => messageView(m, false, true)) });
};

/** Recipients of one field, with the classifier's parser ; the refusal when one does not parse. */
function recipientsOf(
  args: Readonly<Record<string, unknown>>,
  field: 'to' | 'cc' | 'bcc',
): readonly EmailAddress[] | McpToolResult {
  const collected = collectRecipients({ [field]: args[field] });
  return 'denied' in collected
    ? refused('invalid_argument', collected.denied)
    : collected.recipients;
}

function planCreateDraft(
  account: GmailAccount,
  args: Readonly<Record<string, unknown>>,
  now: () => Date,
): Plan {
  const to = recipientsOf(args, 'to');
  if (isRefusal(to)) return to;
  const cc = recipientsOf(args, 'cc');
  if (isRefusal(cc)) return cc;
  const bcc = recipientsOf(args, 'bcc');
  if (isRefusal(bcc)) return bcc;
  const problem = draftProblem(args.subject, args.body);
  if (problem !== null) return refused('invalid_argument', problem);
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
    return structuredResult({
      draft: draft
        ? { id: imapIdToHex(draft.messageId), thread_id: imapIdToHex(draft.threadId) }
        : null,
      sent: false,
    });
  };
}

/** Every recipient of a send, bounded ; the refusal when there is none or too many. */
function sendRecipients(
  fields: readonly (readonly EmailAddress[])[],
): readonly string[] | McpToolResult {
  const all = fields.flat();
  if (all.length === 0) {
    return refused('invalid_argument', 'a send needs at least one recipient in to, cc or bcc.');
  }
  if (all.length > MAX_SEND_RECIPIENTS) {
    return refused('invalid_argument', `a send has at most ${MAX_SEND_RECIPIENTS} recipients.`);
  }
  return [...new Set(all.map((a) => a.address))];
}

/** What a send answers : who Gmail took, and that the copy is Gmail's to file. */
function sentResult(receipt: SmtpReceipt, extra: Record<string, unknown> = {}): McpToolResult {
  return structuredResult({
    sent: true,
    accepted: receipt.accepted,
    rejected: receipt.rejected,
    sent_copy: 'filed in Sent by Gmail',
    ...extra,
  });
}

function planSendMessage(
  account: GmailAccount,
  args: Readonly<Record<string, unknown>>,
  now: () => Date,
): Plan {
  const to = recipientsOf(args, 'to');
  if (isRefusal(to)) return to;
  const cc = recipientsOf(args, 'cc');
  if (isRefusal(cc)) return cc;
  const bcc = recipientsOf(args, 'bcc');
  if (isRefusal(bcc)) return bcc;
  const envelope = sendRecipients([to, cc, bcc]);
  if (isRefusal(envelope)) return envelope;
  const problem = draftProblem(args.subject, args.body);
  if (problem !== null) return refused('invalid_argument', problem);
  // The message a draft would be, without the Bcc header : Bcc travels in the envelope only.
  const raw = buildDraft({
    from: account.email,
    to,
    cc,
    bcc: [],
    subject: args.subject as string,
    body: args.body as string,
    date: now(),
  });
  const recipients: readonly string[] = envelope;
  return {
    smtp: async (send) => sentResult(await send({ from: account.email, to: recipients, raw })),
  };
}

/** The bare addresses of one envelope field, sorted ; `null` when one is not exactly an address. */
function envelopeAddresses(list: readonly ImapAddress[]): string[] | null {
  const out: string[] = [];
  for (const a of list) {
    const parsed = parseBareAddress(a.address);
    if (parsed === null) return null;
    out.push(parsed.address);
  }
  return out.sort();
}

const sameAddresses = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);

const SEND_FIELDS = ['to', 'cc', 'bcc'] as const;
type SendField = (typeof SEND_FIELDS)[number];

/**
 * The draft's recipients checked against the declared ones, field by field ;
 * the refusal when one is not an address or the sets differ.
 */
function draftRecipientsProblem(
  hex: string,
  draft: ImapMessage,
  declared: Readonly<Record<SendField, readonly string[]>>,
): McpToolResult | null {
  const held: Readonly<Record<SendField, readonly ImapAddress[]>> = {
    to: draft.to,
    cc: draft.cc,
    bcc: draft.bcc,
  };
  for (const field of SEND_FIELDS) {
    const actual = envelopeAddresses(held[field]);
    if (actual === null) {
      return refused(
        'invalid_argument',
        `draft ${hex}: a ${field} recipient is not exactly one address; nothing was sent.`,
      );
    }
    if (!sameAddresses(actual, declared[field])) {
      return refused(
        'recipients_mismatch',
        `draft ${hex} is addressed ${field}: [${actual.join(', ')}], not [${declared[field].join(', ')}]; nothing was sent. Call again with the draft's recipients as list_drafts shows them.`,
      );
    }
  }
  return null;
}

function planSendDraft(account: GmailAccount, args: Readonly<Record<string, unknown>>): Plan {
  const id = imapIdArg(args, 'id');
  if (isRefusal(id)) return id;
  const declared: Record<SendField, string[]> = { to: [], cc: [], bcc: [] };
  const fields: (readonly EmailAddress[])[] = [];
  for (const field of SEND_FIELDS) {
    const parsed = recipientsOf(args, field);
    if (isRefusal(parsed)) return parsed;
    fields.push(parsed);
    declared[field] = parsed.map((a) => a.address).sort();
  }
  const envelope = sendRecipients(fields);
  if (isRefusal(envelope)) return envelope;
  const recipients: readonly string[] = envelope;
  return async (session, send) => {
    const drafts = await folder(session, '\\Drafts');
    const [uid] = await session.search(drafts, { messageId: id.decimal });
    if (uid === undefined) {
      return refused('not_found', `no draft ${id.hex} in Drafts (list_drafts gives the ids).`);
    }
    const [draft] = await session.fetch(drafts, [uid], { bodyBytes: null });
    if (!draft) return refused('not_found', `draft ${id.hex} could not be read.`);
    // The call was classified on the declared recipients : the draft must hold exactly them.
    const mismatch = draftRecipientsProblem(id.hex, draft, declared);
    if (mismatch !== null) return mismatch;
    const source = await session.source(drafts, uid, MAX_SENT_DRAFT_BYTES);
    if (source === null) return refused('not_found', `draft ${id.hex} could not be read.`);
    if (source.truncated) {
      return refused(
        'too_large',
        `draft ${id.hex} is larger than ${MAX_SENT_DRAFT_BYTES} bytes (7 MiB), the most send_draft relays.`,
      );
    }
    const receipt = await send({
      from: account.email,
      to: recipients,
      raw: withoutBccHeader(source.content),
    });
    // Sent : it is no longer a draft. A failure here leaves it in Drafts, and says so.
    let removed = true;
    try {
      await session.remove(drafts, [uid]);
    } catch {
      removed = false;
    }
    return sentResult(receipt, { draft_id: id.hex, draft_removed: removed });
  };
}

const listLabels: Work = async (session) => {
  const user = userLabels(await session.mailboxes());
  return structuredResult({
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
    throw refusal('not_found', `no user label '${label}' (list_labels gives the names).`);
  }
  return { op, labels: [listed] };
}

function planLabelWrite(tool: string, args: Readonly<Record<string, unknown>>): Plan {
  const thread = imapIdArg(args, 'thread_id');
  if (isRefusal(thread)) return thread;
  const label = writableLabel(args.label);
  if (label === null)
    return refused('invalid_argument', 'label: missing, malformed, TRASH or SPAM.');
  if (SYSTEM_LABEL_IDS.has(label) && SYSTEM_TO_IMAP[label] === undefined && label !== UNREAD) {
    return refused('unsupported_label', `label ${label} cannot be written over IMAP.`);
  }
  const onMessage = tool === TOOL.labelMessage || tool === TOOL.unlabelMessage;
  const adding = tool === TOOL.labelMessage || tool === TOOL.labelThread;
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
    return structuredResult({
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
    case TOOL.searchThreads:
      return planSearchThreads(args);
    case TOOL.getThread:
      return planGetThread(args);
    case TOOL.getAttachment:
      return planGetAttachment(args);
    case TOOL.createLabel:
      return planCreateLabel(args);
    case TOOL.listDrafts:
      return listDrafts;
    case TOOL.createDraft:
      return planCreateDraft(account, args, now);
    case TOOL.sendMessage:
      return planSendMessage(account, args, now);
    case TOOL.sendDraft:
      return planSendDraft(account, args);
    case TOOL.listLabels:
      return listLabels;
    default:
      return planLabelWrite(tool, args);
  }
}

// ─── Runtime ───────────────────────────────────────────────────────────────

export interface GmailRuntimeOptions {
  /** Defaults to the real `imapflow` transport. */
  readonly transport?: GmailTransport;
  /** Defaults to the real `nodemailer` transport. */
  readonly smtp?: GmailSmtpTransport;
  /** The clock a draft is dated with ; tests pin it. */
  readonly now?: () => Date;
}

export interface GmailRuntime {
  execute(
    ctx: ExecuteContext,
    tool: string,
    args: Readonly<Record<string, unknown>>,
  ): Promise<McpToolResult>;
  discoverResources(ctx: AccountContext): Promise<readonly Resource[]>;
  verify(ctx: AccountContext): Promise<CredentialCheck>;
  /** The credential spec, its `verify` bound to this transport. */
  readonly credential: ApiKeyCredentialSpec;
}

/** The mailbox as the account's single resource. */
export function mailboxResource(email: string): Resource {
  return {
    provider: PROVIDER_ID,
    ref: email,
    displayName: email,
    metadata: { account_email: email },
  };
}

export function createGmailRuntime(options: GmailRuntimeOptions = {}): GmailRuntime {
  const transport = options.transport ?? imapflowTransport;
  const smtp = options.smtp ?? nodemailerSmtpTransport;
  const now = options.now ?? (() => new Date());

  const sessionOptions = (ctx: AccountContext) => ({
    timeoutMs: SESSION_TIMEOUT_MS,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
    ...(ctx.logger ? { logger: ctx.logger } : {}),
  });

  const inSession = <T>(
    account: GmailAccount,
    ctx: AccountContext,
    work: (s: GmailImapSession) => Promise<T>,
  ): Promise<T> => transport.session(account, sessionOptions(ctx), work);

  /** Signs in and checks the two folders every tool needs. */
  const signIn = async (ctx: AccountContext): Promise<GmailAccount> => {
    const account = gmailAccount(ctx.credential);
    await inSession(account, ctx, async (s) => {
      await folder(s, '\\All');
      await folder(s, '\\Drafts');
    });
    return account;
  };

  const verify = async (ctx: AccountContext): Promise<CredentialCheck> => {
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
      if (!GMAIL_CLASSIFIED_TOOLS.includes(tool)) {
        return refused('unknown_tool', `unknown tool '${tool}'.`);
      }
      const mailbox = selectMailbox(ctx.resources);
      if ('denied' in mailbox) return refused('invalid_resource', mailbox.denied);
      if (tool === TOOL.describeZones) {
        return structuredResult({ mailbox: mailbox.ref, zones: readMailboxMetadata(mailbox) });
      }
      const account = gmailAccount(ctx.credential);
      if (mailbox.ref.toLowerCase() !== account.email) {
        return refused(
          'invalid_resource',
          `mailbox '${mailbox.ref}' is not the mailbox of this account.`,
        );
      }
      const send: SendMail = (mail) => smtp.send(account, sessionOptions(ctx), mail);
      try {
        return await declining(async () => {
          const plan = planOf(tool, args, account, now);
          if (isWork(plan)) return inSession(account, ctx, (s) => plan(s, send));
          if (isSmtpWork(plan)) return plan.smtp(send);
          return plan;
        });
      } catch (err) {
        // ⚠ Gmail refusing a send is the provider's failure, yet it stays the
        // tool error the handbook documents (Traps, Debug) : its code for the
        // agent, never an `UpstreamAuthError` — a Workspace administrator can
        // block SMTP while IMAP works.
        if (err instanceof GmailSmtpError) return refused(err.code, err.message);
        throw err;
      }
    },
  };
}
