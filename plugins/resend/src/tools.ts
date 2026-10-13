/**
 * Resend MCP tools — thin wrappers over the Resend REST API (api.resend.com).
 *
 * 27 tools : 9 reads and 18 writes (one of them, `describe_zones`, synthetic).
 * Names follow the SDK convention `<provider>__<verb>_<noun>` (prefix `resend__`).
 *
 * Resource arguments are explicit, as the contributor guide asks :
 *   - `domain`      — the sending domain ref (`notifications.acme.com`) for the
 *                     domain tools ; sends take it from the `from` address ;
 *   - `segment_id`  — the segment ref for segment, membership and broadcast
 *                     tools. Every broadcast tool names its segment so the
 *                     call can be scoped and env-qualified ; `execute` checks
 *                     upstream that the broadcast really belongs to it.
 *
 * Out of scope in v1 (spec §10) and refused by the classifier when present :
 * `attachments`, `scheduled_at`, `send` on broadcast creation.
 *
 * Spec : docs/spec/resend.md §6 ; docs/spec/gateway-risk-model.md §7.
 */

import type { McpToolDeclaration } from '@vaubaan/plugin-sdk';

const DOMAIN_ARG = {
  domain: {
    type: 'string',
    description: 'Sending domain ref as listed in the mission (e.g. "notifications.acme.com").',
  },
} as const;

const SEGMENT_ARG = {
  segment_id: {
    type: 'string',
    description: 'Segment id as listed in the mission.',
  },
} as const;

const ADDRESS_LIST = (what: string) => ({
  type: 'array',
  items: { type: 'string' },
  description: `${what} address(es). "Name <user@domain>" is accepted.`,
});

const EMAIL_CONTENT_PROPS = {
  subject: { type: 'string', description: 'Subject line.' },
  html: { type: 'string', description: 'HTML body.' },
  text: { type: 'string', description: 'Plain-text body (fallback for clients without HTML).' },
  reply_to: ADDRESS_LIST('Reply-to'),
  headers: { type: 'object', description: 'Custom email headers.' },
  tags: {
    type: 'array',
    items: {
      type: 'object',
      properties: { name: { type: 'string' }, value: { type: 'string' } },
    },
    description: 'Tags for categorisation and analytics.',
  },
} as const;

const SINGLE_EMAIL_PROPS = {
  from: {
    type: 'string',
    description:
      'Sender address on a sending domain of the mission, e.g. "Acme <noreply@notifications.acme.com>".',
  },
  to: ADDRESS_LIST('Recipient'),
  cc: ADDRESS_LIST('CC'),
  bcc: ADDRESS_LIST('BCC'),
  ...EMAIL_CONTENT_PROPS,
} as const;

const BROADCAST_CONTENT_PROPS = {
  from: {
    type: 'string',
    description: 'Sender address on a sending domain of the mission.',
  },
  subject: { type: 'string', description: 'Subject line.' },
  html: { type: 'string', description: 'HTML body ; supports {{{contact.first_name|there}}}.' },
  text: { type: 'string', description: 'Plain-text body.' },
  reply_to: ADDRESS_LIST('Reply-to'),
  name: { type: 'string', description: 'Internal campaign name.' },
  preview_text: { type: 'string', description: 'Preview text shown by inbox clients.' },
} as const;

// ─── Read tools ─────────────────────────────────────────────────────────────

const READ_TOOLS: readonly McpToolDeclaration[] = [
  {
    name: 'resend__get_email',
    description: 'Retrieve the status and metadata of a sent email. Backed by GET /emails/:id.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'The email id returned by a send.' } },
      required: ['id'],
    },
  },
  {
    name: 'resend__list_domains',
    description:
      'List the sending domains of the mission with their verification status. Backed by GET /domains.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'resend__get_domain',
    description:
      'Retrieve a sending domain with its DNS records (DKIM, SPF, DMARC). Backed by GET /domains/:id.',
    inputSchema: { type: 'object', properties: { ...DOMAIN_ARG }, required: ['domain'] },
  },
  {
    name: 'resend__list_segments',
    description: 'List the segments (contact lists) of the mission. Backed by GET /segments.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'resend__get_segment',
    description: 'Retrieve a segment. Backed by GET /segments/:id.',
    inputSchema: { type: 'object', properties: { ...SEGMENT_ARG }, required: ['segment_id'] },
  },
  {
    name: 'resend__list_contacts',
    description:
      'List contacts, optionally those of one segment. Contacts carry PII. Backed by GET /contacts.',
    inputSchema: {
      type: 'object',
      properties: {
        segment_id: {
          type: 'string',
          description: 'Restrict to the members of this segment of the mission.',
        },
        limit: { type: 'number', description: 'Page size (1-100).' },
        after: { type: 'string', description: 'Cursor : the contact id to page after.' },
        before: { type: 'string', description: 'Cursor : the contact id to page before.' },
      },
    },
  },
  {
    name: 'resend__get_contact',
    description:
      'Retrieve a contact by id or email address. Carries PII. Backed by GET /contacts/:id.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Contact id or email address.' } },
      required: ['id'],
    },
  },
  {
    name: 'resend__list_broadcasts',
    description: 'List the broadcasts of the segments of the mission. Backed by GET /broadcasts.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'resend__get_broadcast',
    description: 'Retrieve a broadcast of a segment of the mission. Backed by GET /broadcasts/:id.',
    inputSchema: {
      type: 'object',
      properties: { ...SEGMENT_ARG, id: { type: 'string', description: 'The broadcast id.' } },
      required: ['segment_id', 'id'],
    },
  },
];

// ─── Write tools ────────────────────────────────────────────────────────────

const WRITE_TOOLS: readonly McpToolDeclaration[] = [
  {
    name: 'resend__send_email',
    description:
      'Send a transactional email from a sending domain of the mission. Classified by recipient zone ' +
      '(internal / allowlist / external-unbounded) and recipient count. Attachments and scheduling are ' +
      'refused. Backed by POST /emails.',
    inputSchema: {
      type: 'object',
      properties: { ...SINGLE_EMAIL_PROPS },
      required: ['from', 'to', 'subject'],
    },
  },
  {
    name: 'resend__send_batch_emails',
    description:
      'Send up to 100 transactional emails in one call. Every from address must be on a sending domain ' +
      'of the mission ; the worst recipient zone per domain applies. Backed by POST /emails/batch.',
    inputSchema: {
      type: 'object',
      properties: {
        emails: {
          type: 'array',
          items: {
            type: 'object',
            properties: { ...SINGLE_EMAIL_PROPS },
            required: ['from', 'to', 'subject'],
          },
          description: 'Email objects (1 to 100).',
        },
      },
      required: ['emails'],
    },
  },
  {
    name: 'resend__create_domain',
    description:
      'Add a sending domain to the account. Posture shift : the owner must publish the DNS records and ' +
      'add the new resource to missions. Backed by POST /domains.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The domain name (e.g. "notifications.acme.com").' },
        region: {
          type: 'string',
          description:
            'Delivery region : "us-east-1", "eu-west-1", "sa-east-1" or "ap-northeast-1".',
        },
        open_tracking: { type: 'boolean', description: 'Enable open tracking.' },
        click_tracking: { type: 'boolean', description: 'Enable click tracking.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'resend__update_domain',
    description:
      'Update the tracking and TLS settings of a sending domain. Backed by PATCH /domains/:id.',
    inputSchema: {
      type: 'object',
      properties: {
        ...DOMAIN_ARG,
        click_tracking: { type: 'boolean', description: 'Enable or disable click tracking.' },
        open_tracking: { type: 'boolean', description: 'Enable or disable open tracking.' },
        tls: { type: 'string', description: 'TLS policy : "enforced" or "opportunistic".' },
      },
      required: ['domain'],
    },
  },
  {
    name: 'resend__delete_domain',
    description:
      'Remove a sending domain. Breaks delivery for every sender on it. Backed by DELETE /domains/:id.',
    inputSchema: { type: 'object', properties: { ...DOMAIN_ARG }, required: ['domain'] },
  },
  {
    name: 'resend__verify_domain',
    description:
      'Ask Resend to re-check the DNS records of a sending domain. Idempotent. Backed by POST /domains/:id/verify.',
    inputSchema: { type: 'object', properties: { ...DOMAIN_ARG }, required: ['domain'] },
  },
  {
    name: 'resend__create_segment',
    description: 'Create a segment (contact list). Backed by POST /segments.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Segment name.' } },
      required: ['name'],
    },
  },
  {
    name: 'resend__delete_segment',
    description:
      'Delete a segment of the mission. Memberships are lost, contacts survive. Backed by DELETE /segments/:id.',
    inputSchema: { type: 'object', properties: { ...SEGMENT_ARG }, required: ['segment_id'] },
  },
  {
    name: 'resend__create_contact',
    description:
      'Create a contact, optionally as a member of a segment of the mission. Carries PII. ' +
      'Backed by POST /contacts (+ POST /contacts/:id/segments/:segment_id).',
    inputSchema: {
      type: 'object',
      properties: {
        email: { type: 'string', description: 'Contact email address.' },
        first_name: { type: 'string', description: 'First name.' },
        last_name: { type: 'string', description: 'Last name.' },
        unsubscribed: { type: 'boolean', description: 'Unsubscribed from every broadcast.' },
        segment_id: {
          type: 'string',
          description: 'Add the new contact to this segment of the mission.',
        },
      },
      required: ['email'],
    },
  },
  {
    name: 'resend__update_contact',
    description: 'Update a contact by id or email. Carries PII. Backed by PATCH /contacts/:id.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Contact id or email address.' },
        first_name: { type: 'string', description: 'First name.' },
        last_name: { type: 'string', description: 'Last name.' },
        unsubscribed: { type: 'boolean', description: 'Unsubscribed from every broadcast.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'resend__delete_contact',
    description: 'Delete a contact by id or email. Backed by DELETE /contacts/:id.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Contact id or email address.' } },
      required: ['id'],
    },
  },
  {
    name: 'resend__add_contact_to_segment',
    description:
      'Add an existing contact to a segment of the mission. Backed by POST /contacts/:id/segments/:segment_id.',
    inputSchema: {
      type: 'object',
      properties: {
        ...SEGMENT_ARG,
        id: { type: 'string', description: 'Contact id or email address.' },
      },
      required: ['segment_id', 'id'],
    },
  },
  {
    name: 'resend__remove_contact_from_segment',
    description:
      'Remove a contact from a segment of the mission. Backed by DELETE /contacts/:id/segments/:segment_id.',
    inputSchema: {
      type: 'object',
      properties: {
        ...SEGMENT_ARG,
        id: { type: 'string', description: 'Contact id or email address.' },
      },
      required: ['segment_id', 'id'],
    },
  },
  {
    name: 'resend__create_broadcast',
    description:
      'Create a draft broadcast for a segment of the mission. Never sends : "send" and "scheduled_at" ' +
      'are refused. Backed by POST /broadcasts.',
    inputSchema: {
      type: 'object',
      properties: { ...SEGMENT_ARG, ...BROADCAST_CONTENT_PROPS },
      required: ['segment_id', 'from', 'subject'],
    },
  },
  {
    name: 'resend__update_broadcast',
    description:
      'Update a draft broadcast of a segment of the mission. Backed by PATCH /broadcasts/:id.',
    inputSchema: {
      type: 'object',
      properties: {
        ...SEGMENT_ARG,
        id: { type: 'string', description: 'The broadcast id.' },
        ...BROADCAST_CONTENT_PROPS,
      },
      required: ['segment_id', 'id'],
    },
  },
  {
    name: 'resend__send_broadcast',
    description:
      'Send a broadcast to its segment now. Cardinal risk : mass delivery, irreversible. The broadcast ' +
      'must belong to the named segment. Backed by POST /broadcasts/:id/send.',
    inputSchema: {
      type: 'object',
      properties: { ...SEGMENT_ARG, id: { type: 'string', description: 'The broadcast id.' } },
      required: ['segment_id', 'id'],
    },
  },
  {
    name: 'resend__delete_broadcast',
    description:
      'Delete a broadcast of a segment of the mission (cancels it if scheduled). Backed by DELETE /broadcasts/:id.',
    inputSchema: {
      type: 'object',
      properties: { ...SEGMENT_ARG, id: { type: 'string', description: 'The broadcast id.' } },
      required: ['segment_id', 'id'],
    },
  },
  {
    name: 'resend__describe_zones',
    description:
      'Return the recipient-zone configuration (internal_domains, allowlist_domains, allowlist_addresses) ' +
      'of every sending domain of the mission. Synthetic : no upstream call.',
    inputSchema: { type: 'object', properties: {} },
  },
];

export const resendTools: readonly McpToolDeclaration[] = [...READ_TOOLS, ...WRITE_TOOLS];

export const RESEND_WRITE_TOOL_NAMES: ReadonlySet<string> = new Set(WRITE_TOOLS.map((t) => t.name));
