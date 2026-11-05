/**
 * The mail tools of the `outlook` provider on Microsoft Graph v1.0.
 *
 * Handbook : docs/handbook/providers/outlook.md.
 *
 * Every request is built from what `readOutlookCall` returned, field by
 * field. What a write answers is reduced to ids and recipients: Graph answers
 * a PATCH, a move and a reply draft with the whole message, body included,
 * and a write must not read mail its permission did not price.
 */

import {
  ExecutorRefusal,
  UpstreamHttpError,
  UpstreamProtocolError,
  isList,
  isRecord,
  jsonResult,
  type ExecuteContext,
  type Guard,
  type McpToolResult,
} from '@vaubaan/plugin-sdk';

import { parseAddress } from './address.ts';
import type { OutlookCall, Recipients } from './call.ts';
import { graph, odataString, segment } from './graph.ts';
import { graphId, isWellKnownFolder } from './identifiers.ts';
import { DRAFTS_FOLDER, NO_MOVE_FOLDERS, PREFER_TEXT_BODY, TOOL } from './identity.ts';
import type { ParsedQuery } from './q-parser.ts';

/** What one search or one list asks for when the agent does not say. */
const DEFAULT_SEARCH_TOP = 10;
const DEFAULT_DRAFTS_TOP = 25;
/** Folders per list (Graph pages beyond it; the first page only). */
const FOLDERS_PER_LIST = 100;
/** The largest file attachment `get_attachment` returns, in bytes (its base64 fits the 10 MB answer bound). */
export const MAX_ATTACHMENT_BYTES = 7 * 1024 * 1024;
/** How many parents a move destination is walked up to find a refused folder. */
const MAX_FOLDER_DEPTH = 10;
/** The lower bound of every `$filter`, so `$orderby=receivedDateTime desc` is accepted. */
const EPOCH_FILTER = '1900-01-01T00:00:00Z';

const SELECT_LIST =
  'id,subject,from,toRecipients,ccRecipients,receivedDateTime,isRead,hasAttachments,bodyPreview,conversationId,parentFolderId,flag,categories,isDraft';
const SELECT_MESSAGE = `${SELECT_LIST},bccRecipients,replyTo,sentDateTime,importance,internetMessageId,body`;
const SELECT_DRAFT =
  'id,subject,toRecipients,ccRecipients,bccRecipients,lastModifiedDateTime,hasAttachments,bodyPreview';
const SELECT_FOLDER =
  'id,displayName,parentFolderId,childFolderCount,unreadItemCount,totalItemCount';
const SELECT_ATTACHMENT = 'id,name,contentType,size,isInline,lastModifiedDateTime';

type Record_ = Readonly<Record<string, unknown>>;

interface Page {
  readonly value: readonly unknown[];
}

const isPage: Guard<Page> = (x): x is Page => isRecord(x) && isList(x.value);

interface WithId {
  readonly id: string;
}

const hasId: Guard<WithId & Record_> = (x): x is WithId & Record_ =>
  isRecord(x) && typeof x.id === 'string';

// ─── Recipients ─────────────────────────────────────────────────────────────

function recipientObjects(addresses: readonly string[]): { emailAddress: { address: string } }[] {
  return addresses.map((address) => ({ emailAddress: { address } }));
}

/** The addresses of a Graph recipient list, lower-cased and sorted; `null` when one is not an address. */
function addressesIn(value: unknown): string[] | null {
  if (value === undefined || value === null) return [];
  if (!isList(value)) return null;
  const out: string[] = [];
  for (const r of value) {
    const address =
      isRecord(r) && isRecord(r.emailAddress) ? parseAddress(r.emailAddress.address) : null;
    if (address === null) return null;
    if (!out.includes(address.address)) out.push(address.address);
  }
  return out.sort();
}

/** The address of a message's `from`, lower-cased, or `null`. */
function senderOf(message: Record_): string | null {
  const from = message.from;
  return isRecord(from) && isRecord(from.emailAddress)
    ? (parseAddress(from.emailAddress.address)?.address ?? null)
    : null;
}

function messageBody(
  subject: unknown,
  body: unknown,
  recipients: Recipients,
): Record<string, unknown> {
  return {
    ...(typeof subject === 'string' ? { subject } : {}),
    body: { contentType: 'Text', content: typeof body === 'string' ? body : '' },
    toRecipients: recipientObjects(recipients.to),
    ccRecipients: recipientObjects(recipients.cc),
    bccRecipients: recipientObjects(recipients.bcc),
  };
}

// ─── Search ─────────────────────────────────────────────────────────────────

/**
 * Whether a message the provider answered holds every term of the query —
 * the bound applied after a full-text search (Graph does not combine
 * `$search` with `$filter`), and checked again after a `$filter` as a second
 * lock. A message whose fields cannot be read does not hold.
 */
export function holdsQuery(message: Record_, query: ParsedQuery): boolean {
  const sender = senderOf(message);
  if (query.from.some((a) => a !== sender)) return false;
  if (query.to.length > 0) {
    const to = addressesIn(message.toRecipients);
    if (to === null || query.to.some((a) => !to.includes(a))) return false;
  }
  if (query.subjects.length > 0) {
    const subject = typeof message.subject === 'string' ? message.subject.toLowerCase() : null;
    if (subject === null || query.subjects.some((w) => !subject.includes(w.toLowerCase()))) {
      return false;
    }
  }
  if (query.unread && message.isRead !== false) return false;
  if (query.hasAttachment && message.hasAttachments !== true) return false;
  if (query.after !== null || query.before !== null) {
    const received =
      typeof message.receivedDateTime === 'string' ? Date.parse(message.receivedDateTime) : NaN;
    if (Number.isNaN(received)) return false;
    if (query.after !== null && received < Date.parse(`${query.after}T00:00:00Z`)) return false;
    if (query.before !== null && received >= Date.parse(`${query.before}T00:00:00Z`)) return false;
  }
  return true;
}

/** The `$filter` of a query without free words: received first, so the order by received holds. */
export function filterOf(query: ParsedQuery): string {
  const clauses = [
    `receivedDateTime ge ${query.after !== null ? `${query.after}T00:00:00Z` : EPOCH_FILTER}`,
  ];
  if (query.before !== null) clauses.push(`receivedDateTime lt ${query.before}T00:00:00Z`);
  for (const address of query.from)
    clauses.push(`from/emailAddress/address eq ${odataString(address)}`);
  if (query.unread) clauses.push('isRead eq false');
  if (query.hasAttachment) clauses.push('hasAttachments eq true');
  return clauses.join(' and ');
}

async function searchMessages(ctx: ExecuteContext, call: OutlookCall): Promise<unknown> {
  const query = call.query;
  if (query === null) throw new ExecutorRefusal('query: missing.');
  const base =
    call.folder === null
      ? '/me/messages'
      : `/me/mailFolders/${segment(call.folder, 'folder')}/messages`;
  const top = typeof call.values.top === 'number' ? call.values.top : DEFAULT_SEARCH_TOP;
  const fullText = query.words.length > 0;
  const page = await graph(ctx, 'GET', base, {
    query: fullText
      ? { $search: `"${query.words.join(' ')}"`, $top: top, $select: SELECT_LIST }
      : {
          $filter: filterOf(query),
          $orderby: 'receivedDateTime desc',
          $top: top,
          $select: SELECT_LIST,
        },
    guard: isPage,
  });
  const messages = (page?.value ?? []).filter(isRecord).filter((m) => holdsQuery(m, query));
  return {
    messages,
    note: fullText
      ? 'The first page of a full-text search (sorted by Microsoft), then narrowed to the other terms: ask with a larger top for more.'
      : 'The first page, newest first: ask with a larger top or a narrower query for more.',
  };
}

// ─── Reads ──────────────────────────────────────────────────────────────────

function messagePath(call: OutlookCall): string {
  return `/me/messages/${segment(call.messageId, 'message_id')}`;
}

interface AttachmentMeta {
  readonly '@odata.type'?: string;
  readonly id: string;
  readonly size?: number;
  readonly [field: string]: unknown;
}

const isAttachmentMeta: Guard<AttachmentMeta> = (x): x is AttachmentMeta =>
  isRecord(x) &&
  typeof x.id === 'string' &&
  (x.size === undefined || typeof x.size === 'number') &&
  (x['@odata.type'] === undefined || typeof x['@odata.type'] === 'string');

const FILE_ATTACHMENT = '#microsoft.graph.fileAttachment';

async function getAttachment(ctx: ExecuteContext, call: OutlookCall): Promise<unknown> {
  const path = `${messagePath(call)}/attachments/${segment(call.attachmentId, 'attachment_id')}`;
  const meta = await graph(ctx, 'GET', path, {
    query: { $select: SELECT_ATTACHMENT },
    guard: isAttachmentMeta,
  });
  if (meta === null) throw new UpstreamProtocolError(`Microsoft Graph GET ${path}: no attachment`);
  if (typeof meta.size === 'number' && meta.size > MAX_ATTACHMENT_BYTES) {
    throw new ExecutorRefusal(
      `attachment of ${meta.size} bytes: larger than ${MAX_ATTACHMENT_BYTES} bytes (7 MB), the most get_attachment returns.`,
    );
  }
  const kind = meta['@odata.type'];
  if (kind !== undefined && kind !== FILE_ATTACHMENT) {
    return {
      ...meta,
      note: 'Not a file (an attached item or a link): its content is not downloaded.',
    };
  }
  const file = await graph(ctx, 'GET', path, {
    guard: (x): x is Record_ =>
      isRecord(x) && (x.contentBytes === undefined || typeof x.contentBytes === 'string'),
  });
  return file;
}

// ─── Drafts and sends ───────────────────────────────────────────────────────

function recipientsOrRefuse(call: OutlookCall): Recipients {
  if (call.recipients === null) throw new ExecutorRefusal('recipients: missing.');
  return call.recipients;
}

async function createDraft(ctx: ExecuteContext, call: OutlookCall): Promise<unknown> {
  const recipients = recipientsOrRefuse(call);
  const draft = await graph(ctx, 'POST', '/me/messages', {
    body: messageBody(call.values.subject, call.values.body, recipients),
    guard: hasId,
  });
  if (draft === null)
    throw new UpstreamProtocolError('Microsoft Graph POST /me/messages: no draft');
  return { draft_id: draft.id, subject: call.values.subject, ...recipients };
}

/**
 * A reply draft: `createReply` / `createReplyAll` with the body as Graph's
 * `comment`, then a PATCH setting the recipients to exactly the declared
 * ones (Graph's prefilled recipients are unknown before the call). When the
 * PATCH fails, the new draft is deleted, so no draft holds recipients the
 * call was not priced on, and the failure is thrown.
 */
async function createReplyDraft(ctx: ExecuteContext, call: OutlookCall): Promise<unknown> {
  const recipients = recipientsOrRefuse(call);
  const action = call.values.reply_all === true ? 'createReplyAll' : 'createReply';
  const created = await graph(ctx, 'POST', `${messagePath(call)}/${action}`, {
    body: { comment: typeof call.values.body === 'string' ? call.values.body : '' },
    guard: hasId,
  });
  const draftId = graphId(created?.id);
  if (draftId === null) {
    throw new UpstreamProtocolError(
      `Microsoft Graph POST ${action}: the reply draft's id is not a Graph id; it is in Drafts, unsent, with Microsoft's recipients`,
    );
  }
  const draftPath = `/me/messages/${segment(draftId, 'draft id')}`;
  try {
    await graph(ctx, 'PATCH', draftPath, {
      body: {
        toRecipients: recipientObjects(recipients.to),
        ccRecipients: recipientObjects(recipients.cc),
        bccRecipients: [],
      },
    });
  } catch (err) {
    await graph(ctx, 'DELETE', draftPath).catch(() => null);
    throw err;
  }
  return {
    draft_id: draftId,
    reply_to: call.messageId,
    reply_all: call.values.reply_all === true,
    to: recipients.to,
    cc: recipients.cc,
  };
}

async function sendMessage(ctx: ExecuteContext, call: OutlookCall): Promise<unknown> {
  const recipients = recipientsOrRefuse(call);
  await graph(ctx, 'POST', '/me/sendMail', {
    body: {
      message: messageBody(call.values.subject, call.values.body, recipients),
      saveToSentItems: true,
    },
  });
  return { sent: true, ...recipients };
}

interface StoredDraft {
  readonly isDraft?: unknown;
  readonly toRecipients?: unknown;
  readonly ccRecipients?: unknown;
  readonly bccRecipients?: unknown;
}

const isStoredDraft: Guard<StoredDraft> = (x): x is StoredDraft => isRecord(x);

/**
 * `send_draft`: the stored draft is read and its recipients compared, field
 * by field, with the declared ones the call was priced on; any difference
 * refuses the call, unsent. Then `POST …/send`.
 */
async function sendDraft(ctx: ExecuteContext, call: OutlookCall): Promise<unknown> {
  const declared = recipientsOrRefuse(call);
  const path = `/me/messages/${segment(call.draftId, 'draft_id')}`;
  const stored = await graph(ctx, 'GET', path, {
    query: { $select: 'id,isDraft,toRecipients,ccRecipients,bccRecipients' },
    guard: isStoredDraft,
  });
  if (stored === null || stored.isDraft !== true) {
    throw new ExecutorRefusal(`${call.draftId}: not a draft; nothing was sent.`);
  }
  for (const field of ['to', 'cc', 'bcc'] as const) {
    const held = addressesIn(stored[`${field}Recipients`]);
    if (held === null) {
      throw new ExecutorRefusal(
        `the draft's ${field} holds a recipient that is not one address; nothing was sent.`,
      );
    }
    const want = [...declared[field]].sort();
    if (held.length !== want.length || held.some((a, i) => a !== want[i])) {
      throw new ExecutorRefusal(
        `the draft is addressed ${field}: [${held.join(', ')}], not [${want.join(', ')}]; nothing was sent. Call again with the draft's recipients as list_drafts shows them.`,
      );
    }
  }
  await graph(ctx, 'POST', `${path}/send`);
  return { sent: true, draft_id: call.draftId, ...declared };
}

// ─── Organise ───────────────────────────────────────────────────────────────

interface FolderLink {
  readonly id: string;
  readonly parentFolderId?: string;
}

const isFolderLink: Guard<FolderLink> = (x): x is FolderLink =>
  isRecord(x) &&
  typeof x.id === 'string' &&
  (x.parentFolderId === undefined ||
    x.parentFolderId === null ||
    typeof x.parentFolderId === 'string');

async function folderLink(ctx: ExecuteContext, folder: string): Promise<FolderLink | null> {
  try {
    return await graph(ctx, 'GET', `/me/mailFolders/${segment(folder, 'folder')}`, {
      query: { $select: 'id,parentFolderId' },
      guard: isFolderLink,
    });
  } catch (err) {
    if (err instanceof UpstreamHttpError && err.status === 404) return null;
    throw err;
  }
}

/**
 * Refuses a destination folder id that is, or is under, a folder a move may
 * not reach: the ids of those well-known folders are read, then the
 * destination's parents, up to `MAX_FOLDER_DEPTH` levels (deeper is refused).
 */
async function refuseDeletingDestination(ctx: ExecuteContext, folder: string): Promise<void> {
  const refused = new Set<string>();
  for (const name of NO_MOVE_FOLDERS) {
    const link = await folderLink(ctx, name);
    if (link !== null) refused.add(link.id);
  }
  const root = await folderLink(ctx, 'msgfolderroot');
  let current: string | null = folder;
  for (let depth = 0; depth <= MAX_FOLDER_DEPTH; depth++) {
    if (current === null) return;
    if (refused.has(current)) {
      throw new ExecutorRefusal(
        'folder: it is, or is under, a folder that deletes or sends mail; nothing was moved.',
      );
    }
    if (root !== null && current === root.id) return;
    const link = await folderLink(ctx, current);
    if (link === null) throw new ExecutorRefusal('folder: no such folder in this mailbox.');
    if (refused.has(link.id)) {
      throw new ExecutorRefusal(
        'folder: it is, or is under, a folder that deletes or sends mail; nothing was moved.',
      );
    }
    const parent = typeof link.parentFolderId === 'string' ? graphId(link.parentFolderId) : null;
    current = parent === null || parent === link.id ? null : parent;
  }
  throw new ExecutorRefusal('folder: nested too deep to check; nothing was moved.');
}

async function moveMessage(ctx: ExecuteContext, call: OutlookCall): Promise<unknown> {
  const folder = call.folder;
  if (folder === null || NO_MOVE_FOLDERS.has(folder))
    throw new ExecutorRefusal('folder: not a destination.');
  if (!isWellKnownFolder(folder)) await refuseDeletingDestination(ctx, folder);
  const moved = await graph(ctx, 'POST', `${messagePath(call)}/move`, {
    body: { destinationId: folder },
    guard: hasId,
  });
  return { moved: true, message_id: moved?.id ?? call.messageId, folder };
}

async function updateMessage(ctx: ExecuteContext, call: OutlookCall): Promise<unknown> {
  const v = call.values;
  const body: Record<string, unknown> = {};
  if (typeof v.is_read === 'boolean') body.isRead = v.is_read;
  if (typeof v.flag === 'string') body.flag = { flagStatus: v.flag };
  if (Array.isArray(v.categories)) body.categories = v.categories;
  const updated = await graph(ctx, 'PATCH', messagePath(call), { body, guard: hasId });
  const answer: Record_ = updated ?? {};
  return {
    message_id: call.messageId,
    isRead: answer.isRead,
    flag: answer.flag,
    categories: answer.categories,
  };
}

async function createFolder(ctx: ExecuteContext, call: OutlookCall): Promise<unknown> {
  const path =
    call.parent === null
      ? '/me/mailFolders'
      : `/me/mailFolders/${segment(call.parent, 'parent')}/childFolders`;
  const created = await graph(ctx, 'POST', path, {
    body: { displayName: call.values.name },
    guard: hasId,
  });
  return {
    folder_id: created?.id,
    displayName: created?.displayName,
    parentFolderId: created?.parentFolderId,
  };
}

// ─── Dispatch ───────────────────────────────────────────────────────────────

export async function executeMail(ctx: ExecuteContext, call: OutlookCall): Promise<McpToolResult> {
  switch (call.tool) {
    case TOOL.describeZones:
      return jsonResult({ mailbox: call.mailbox.ref, zones: call.zoning });
    case TOOL.listFolders: {
      const path =
        call.parent === null
          ? '/me/mailFolders'
          : `/me/mailFolders/${segment(call.parent, 'parent')}/childFolders`;
      return jsonResult(
        await graph(ctx, 'GET', path, {
          query: { $top: FOLDERS_PER_LIST, $select: SELECT_FOLDER },
          guard: isPage,
        }),
      );
    }
    case TOOL.searchMessages:
      return jsonResult(await searchMessages(ctx, call));
    case TOOL.getMessage:
      return jsonResult(
        await graph(ctx, 'GET', messagePath(call), {
          query: { $select: SELECT_MESSAGE },
          prefer: [PREFER_TEXT_BODY],
          guard: hasId,
        }),
      );
    case TOOL.listAttachments:
      return jsonResult(
        await graph(ctx, 'GET', `${messagePath(call)}/attachments`, {
          query: { $select: SELECT_ATTACHMENT },
          guard: isPage,
        }),
      );
    case TOOL.getAttachment:
      return jsonResult(await getAttachment(ctx, call));
    case TOOL.listDrafts:
      return jsonResult(
        await graph(ctx, 'GET', `/me/mailFolders/${DRAFTS_FOLDER}/messages`, {
          query: {
            $top: typeof call.values.top === 'number' ? call.values.top : DEFAULT_DRAFTS_TOP,
            $select: SELECT_DRAFT,
            $orderby: 'lastModifiedDateTime desc',
          },
          guard: isPage,
        }),
      );
    case TOOL.createDraft:
      return jsonResult(await createDraft(ctx, call));
    case TOOL.createReplyDraft:
      return jsonResult(await createReplyDraft(ctx, call));
    case TOOL.sendMessage:
      return jsonResult(await sendMessage(ctx, call));
    case TOOL.sendDraft:
      return jsonResult(await sendDraft(ctx, call));
    case TOOL.moveMessage:
      return jsonResult(await moveMessage(ctx, call));
    case TOOL.updateMessage:
      return jsonResult(await updateMessage(ctx, call));
    case TOOL.createFolder:
      return jsonResult(await createFolder(ctx, call));
    default:
      throw new ExecutorRefusal(`unknown tool '${call.tool}'`);
  }
}
