/**
 * Tools of the `gmail` provider.
 *
 * Spec : docs/spec/vaubaan-gateway.md §5 (plugins).
 * Handbook : docs/handbook/providers/gmail.md.
 *
 * The plugin is **experimental and classifier-only** : `gmailTools` (what the
 * gateway lists to MCP clients) is empty, so no agent is offered a Gmail tool
 * and `execute` never runs for real. The classifier nevertheless models the
 * nine tools of the official Google Gmail MCP server
 * (`gmailmcp.googleapis.com`) plus one synthetic Vaubaan tool,
 * `gmail__describe_zones`, which returns the mailbox zoning configuration.
 * Their declarations live in `gmailClassifiedToolDeclarations` so the test
 * kit can check catalog coverage and so the execution phase can expose them
 * by moving them into `gmailTools`.
 *
 * Argument names are the v4 ones the classifier reads (`q`, `id`,
 * `thread_id`, `message_id`, `to` / `cc` / `bcc`) ; the execution phase maps
 * them onto the upstream names (`threadId`, `labelIds`…).
 */

import type { McpToolDeclaration } from '@vaubaan/plugin-sdk';

export const GMAIL_TOOL_PREFIX = 'gmail__';

/** The ten tools the classifier knows. Any other name is `denied`. */
export const GMAIL_CLASSIFIED_TOOLS = [
  'gmail__describe_zones',
  'gmail__search_threads',
  'gmail__get_thread',
  'gmail__list_drafts',
  'gmail__create_draft',
  'gmail__list_labels',
  'gmail__label_message',
  'gmail__unlabel_message',
  'gmail__label_thread',
  'gmail__unlabel_thread',
] as const;

export type GmailClassifiedTool = (typeof GMAIL_CLASSIFIED_TOOLS)[number];

const threadIdArg = {
  thread_id: { type: 'string', description: 'Gmail thread id (from search_threads).' },
};
const labelArg = {
  label: {
    type: 'string',
    description:
      'Label id — a system label (INBOX, STARRED, UNREAD, IMPORTANT) or a user label id from list_labels.',
  },
};
const recipients = {
  type: 'array',
  items: { type: 'string' },
  description: 'Addresses, as `addr@example.com` or `Name <addr@example.com>`.',
};

/**
 * Declarations of the classified tools. **Not exposed** (`gmailTools` is
 * empty) : kept for the coverage test and for the execution phase.
 */
export const gmailClassifiedToolDeclarations: readonly McpToolDeclaration[] = [
  {
    name: 'gmail__describe_zones',
    description:
      'Return the zoning configuration of the mailbox (internal domains, allowlists, sensitive labels) so the agent knows which risks a read or draft will trigger. Synthetic Vaubaan tool ; no upstream call.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'gmail__search_threads',
    description:
      'Search threads with a Gmail query (`from:`, `to:`, `label:`, `subject:`…). A query without from:/to:/label: is a bulk read.',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'Gmail search query.' },
        max_results: { type: 'integer', description: 'Page size.' },
      },
      required: ['q'],
    },
  },
  {
    name: 'gmail__get_thread',
    description:
      'Read a thread and its messages. Classified as a read from an unknown sender (the sender is only known after the fetch).',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Thread id.' } },
      required: ['id'],
    },
  },
  {
    name: 'gmail__list_drafts',
    description: 'List the drafts of the mailbox.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'gmail__create_draft',
    description:
      'Create a draft (never sends). The risk depends on the recipients : self, internal, allowlisted, or external.',
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
    name: 'gmail__list_labels',
    description: 'List the system and user labels of the mailbox.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'gmail__label_message',
    description: 'Add a label to one message.',
    inputSchema: {
      type: 'object',
      properties: { ...threadIdArg, message_id: { type: 'string' }, ...labelArg },
      required: ['message_id', 'label'],
    },
  },
  {
    name: 'gmail__unlabel_message',
    description: 'Remove a label from one message.',
    inputSchema: {
      type: 'object',
      properties: { ...threadIdArg, message_id: { type: 'string' }, ...labelArg },
      required: ['message_id', 'label'],
    },
  },
  {
    name: 'gmail__label_thread',
    description: 'Add a label to every message of a thread.',
    inputSchema: {
      type: 'object',
      properties: { ...threadIdArg, ...labelArg },
      required: ['thread_id', 'label'],
    },
  },
  {
    name: 'gmail__unlabel_thread',
    description: 'Remove a label from every message of a thread.',
    inputSchema: {
      type: 'object',
      properties: { ...threadIdArg, ...labelArg },
      required: ['thread_id', 'label'],
    },
  },
];

/** What the gateway lists to MCP clients. Empty while the plugin is experimental. */
export const gmailTools: readonly McpToolDeclaration[] = [];
