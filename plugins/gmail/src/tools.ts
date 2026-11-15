/**
 * Tools of the `gmail` service.
 *
 * Spec : docs/spec/vaubaan-gateway.md §5 (plugins).
 * Handbook : docs/handbook/services/gmail.md.
 *
 * The fourteen tools are exposed and execute over IMAP, and the two that
 * send over SMTP (`execute.ts`, ADR gmail-over-imap-with-an-app-password) —
 * thirteen that read (attachments included), draft, send, label and create
 * labels, plus one synthetic Vaubaan tool, `gmail__describe_zones`, which
 * returns the mailbox zoning configuration without any upstream call.
 *
 * Argument names are the ones the classifier reads (`q`, `id`,
 * `thread_id`, `message_id`, `part`, `label`, `name`, `to` / `cc` / `bcc`), and execute reads
 * the same ones. The `required` lists mirror the classifier : it refuses a
 * call whose id or label is missing.
 */

import type { McpToolDeclaration } from '@vaubaan/plugin-sdk';

import { TOOL } from './identity.ts';

const threadIdArg = {
  thread_id: {
    type: 'string',
    description: 'Thread id from search_threads: up to 16 lower-case hexadecimal digits.',
  },
};
const messageIdArg = {
  message_id: {
    type: 'string',
    description: 'Message id from get_thread: up to 16 lower-case hexadecimal digits.',
  },
};
const labelArg = {
  label: {
    type: 'string',
    description:
      'A system label (INBOX, STARRED, IMPORTANT, UNREAD) or the name of a user label exactly as list_labels returns it (spaces and accents allowed, "/" for nesting). TRASH and SPAM are refused.',
  },
};
const recipients = {
  type: 'array',
  items: { type: 'string' },
  description:
    'Addresses, one per element, as `addr@example.com` or `Name <addr@example.com>`. An element that is not exactly one address refuses the call.',
};

/** Declarations of the fourteen tools, in `TOOL` order. */
export const gmailClassifiedToolDeclarations: readonly McpToolDeclaration[] = [
  {
    name: TOOL.describeZones,
    description:
      'Return the zoning configuration of the mailbox (internal domains, allowlists, sensitive labels) so the agent knows which risks a read or draft will trigger. Synthetic Vaubaan tool ; no upstream call.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: TOOL.searchThreads,
    description:
      'Search threads with a Gmail query (`from:`, `to:`, `label:`, `newer_than:`…). Only a plain conjunction holding a `from:<full address>` clause is a bounded read ; an `OR`, a grouping, a quoted phrase or a query without such a clause is a bulk read from unknown senders.',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'Gmail search query, as in the Gmail search box.' },
        max_results: {
          type: 'integer',
          description: 'Threads to return, newest first: 10 by default, 50 at most.',
        },
      },
      required: ['q'],
    },
  },
  {
    name: TOOL.getThread,
    description:
      'Read a thread: the headers, labels, text body (capped; an HTML-only message is converted to text, links kept) and the list of attachments of its newest 50 messages. Classified as a read from an unknown sender, and of a sensitive label when the mailbox declares some (sender and labels are only known after the fetch).',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Thread id from search_threads: up to 16 lower-case hexadecimal digits.',
        },
      },
      required: ['id'],
    },
  },
  {
    name: TOOL.getAttachment,
    description:
      'Download one attachment of a message, base64-encoded, at most 5 MiB (a larger one is refused). The part comes from the attachments get_thread lists. Classified like get_thread: a read from an unknown sender, and of a sensitive label when the mailbox declares some.',
    inputSchema: {
      type: 'object',
      properties: {
        ...threadIdArg,
        ...messageIdArg,
        part: {
          type: 'string',
          description:
            'The MIME part number get_thread lists for the attachment, such as "2" or "1.2".',
        },
      },
      required: ['thread_id', 'message_id', 'part'],
    },
  },
  {
    name: TOOL.listDrafts,
    description: 'List the drafts of the mailbox, with their recipients (Bcc included).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: TOOL.createDraft,
    description:
      'Create a plain-text draft in the Drafts folder; it is never sent. The risk depends on the recipients : self, internal or allowlisted. A recipient outside the internal domains and the allowlists refuses the draft.',
    inputSchema: {
      type: 'object',
      properties: {
        to: recipients,
        cc: recipients,
        bcc: recipients,
        subject: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['subject', 'body'],
    },
  },
  {
    name: TOOL.sendMessage,
    description:
      'Send a plain-text message over SMTP, from the mailbox; it cannot be called back. The risk depends on the recipients : self, internal, allowlisted or external (the worst recipient wins). 1 to 100 recipients. Gmail files the copy in Sent.',
    inputSchema: {
      type: 'object',
      properties: {
        to: recipients,
        cc: recipients,
        bcc: recipients,
        subject: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['subject', 'body'],
    },
  },
  {
    name: TOOL.sendDraft,
    description:
      'Send an existing draft as it is (attachments and formatting kept), then remove it from Drafts; it cannot be called back. Give its id and its recipients exactly as list_drafts shows them : the risk is priced on them, and the call is refused, unsent, when the draft holds others. Gmail files the copy in Sent.',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Draft id from list_drafts: up to 16 lower-case hexadecimal digits.',
        },
        to: recipients,
        cc: recipients,
        bcc: recipients,
      },
      required: ['id'],
    },
  },
  {
    name: TOOL.listLabels,
    description: 'List the system and user labels of the mailbox.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: TOOL.createLabel,
    description:
      'Create a user label, nested with "/" (Clients/2026). Refused when it exists, when it names a system label or folder, or when it is under [Gmail]/. Deletes nothing and moves no message.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description:
            'The label name: letters, digits, spaces and common punctuation, "/" for nesting, at most 225 characters.',
        },
      },
      required: ['name'],
    },
  },
  {
    name: TOOL.labelMessage,
    description: 'Add a label to one message.',
    inputSchema: {
      type: 'object',
      properties: { ...threadIdArg, ...messageIdArg, ...labelArg },
      required: ['thread_id', 'message_id', 'label'],
    },
  },
  {
    name: TOOL.unlabelMessage,
    description: 'Remove a label from one message.',
    inputSchema: {
      type: 'object',
      properties: { ...threadIdArg, ...messageIdArg, ...labelArg },
      required: ['thread_id', 'message_id', 'label'],
    },
  },
  {
    name: TOOL.labelThread,
    description: 'Add a label to every message of a thread.',
    inputSchema: {
      type: 'object',
      properties: { ...threadIdArg, ...labelArg },
      required: ['thread_id', 'label'],
    },
  },
  {
    name: TOOL.unlabelThread,
    description: 'Remove a label from every message of a thread.',
    inputSchema: {
      type: 'object',
      properties: { ...threadIdArg, ...labelArg },
      required: ['thread_id', 'label'],
    },
  },
];

/** What the gateway lists to MCP clients : every classified tool. */
export const gmailTools: readonly McpToolDeclaration[] = gmailClassifiedToolDeclarations;

/** The fourteen tools the classifier knows, in `tools/list` order. Any other name is `denied`. */
export const GMAIL_CLASSIFIED_TOOLS: readonly string[] = gmailClassifiedToolDeclarations.map(
  (t) => t.name,
);
