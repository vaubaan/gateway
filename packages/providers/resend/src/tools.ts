/**
 * Resend MCP tools — all custom, no upstream MCP server to rewrap.
 *
 * 25 tools total :
 *   - 9 reads (GET endpoints against api.resend.com)
 *   - 16 writes (POST/PUT/PATCH/DELETE endpoints against api.resend.com +
 *     1 synthetic `describe_zones`)
 *
 * Names are prefixed `resend__` to match the Vaubaan policy DSL
 * provider scoping convention.
 *
 * Spec : docs/spec/resend.md §6.
 */

import type { McpToolDeclaration } from '@vaubaan/shared';

// ─── Read tools ─────────────────────────────────────────────────────────────

const READ_TOOLS: readonly McpToolDeclaration[] = [
  {
    name: 'resend__get_email',
    description: 'Retrieve the status and metadata of a sent email. Backed by GET /emails/:id.',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'The email id returned by the send call.',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'resend__list_domains',
    description: 'List all verified sending domains. Backed by GET /domains.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'resend__get_domain',
    description:
      'Retrieve a single domain with its DNS verification records. Backed by GET /domains/:id.',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'The domain id.',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'resend__list_audiences',
    description: 'List all audiences (contact lists). Backed by GET /audiences.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'resend__get_audience',
    description: 'Retrieve a single audience by id. Backed by GET /audiences/:id.',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'The audience id.',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'resend__list_contacts',
    description:
      'List all contacts in an audience. Contacts carry PII (email, name). Backed by GET /audiences/:id/contacts.',
    inputSchema: {
      type: 'object',
      properties: {
        audience_id: {
          type: 'string',
          description: 'The audience id to list contacts from.',
        },
      },
      required: ['audience_id'],
    },
  },
  {
    name: 'resend__get_contact',
    description: 'Retrieve a single contact by id. Carries PII. Backed by GET /contacts/:id.',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'The contact id.',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'resend__list_broadcasts',
    description: 'List all broadcasts. Backed by GET /broadcasts.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'resend__get_broadcast',
    description: 'Retrieve a single broadcast by id. Backed by GET /broadcasts/:id.',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'The broadcast id.',
        },
      },
      required: ['id'],
    },
  },
];

// ─── Write tools ────────────────────────────────────────────────────────────

const WRITE_TOOLS: readonly McpToolDeclaration[] = [
  {
    name: 'resend__send_email',
    description:
      'Send a transactional email. Classified by recipient to-zone (internal/allowlist/external-unbounded). Attachments blocked in v1. Backed by POST /emails.',
    inputSchema: {
      type: 'object',
      properties: {
        from: {
          type: 'string',
          description:
            'Sender email address (must be from a verified domain). E.g. "noreply@notifications.acme.com".',
        },
        to: {
          type: 'array',
          items: { type: 'string' },
          description: 'Recipient email address(es).',
        },
        cc: {
          type: 'array',
          items: { type: 'string' },
          description: 'CC recipient email address(es).',
        },
        bcc: {
          type: 'array',
          items: { type: 'string' },
          description: 'BCC recipient email address(es).',
        },
        subject: {
          type: 'string',
          description: 'Email subject line.',
        },
        html: {
          type: 'string',
          description: 'HTML body of the email.',
        },
        text: {
          type: 'string',
          description: 'Plain text body (fallback for clients that do not render HTML).',
        },
        reply_to: {
          type: 'array',
          items: { type: 'string' },
          description: 'Reply-to address(es).',
        },
        tags: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              value: { type: 'string' },
            },
          },
          description: 'Tags for categorisation and analytics.',
        },
        headers: {
          type: 'object',
          description: 'Custom email headers.',
        },
      },
      required: ['from', 'to', 'subject'],
    },
  },
  {
    name: 'resend__send_batch_emails',
    description:
      'Send a batch of up to 100 transactional emails in one call. Worst-case to-zone computed across all emails. Backed by POST /emails/batch.',
    inputSchema: {
      type: 'object',
      properties: {
        emails: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              from: { type: 'string', description: 'Sender email address.' },
              to: {
                type: 'array',
                items: { type: 'string' },
                description: 'Recipient email address(es).',
              },
              cc: {
                type: 'array',
                items: { type: 'string' },
                description: 'CC recipients.',
              },
              bcc: {
                type: 'array',
                items: { type: 'string' },
                description: 'BCC recipients.',
              },
              subject: { type: 'string', description: 'Subject line.' },
              html: { type: 'string', description: 'HTML body.' },
              text: { type: 'string', description: 'Plain text body.' },
              reply_to: {
                type: 'array',
                items: { type: 'string' },
                description: 'Reply-to addresses.',
              },
              tags: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    value: { type: 'string' },
                  },
                },
                description: 'Tags.',
              },
              headers: { type: 'object', description: 'Custom headers.' },
            },
            required: ['from', 'to', 'subject'],
          },
          description: 'Array of email objects (max 100).',
        },
      },
      required: ['emails'],
    },
  },
  {
    name: 'resend__create_domain',
    description:
      'Add a new sending domain. Posture-shift : changes what the account can send from. Backed by POST /domains.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'The domain name (e.g. "notifications.acme.com").',
        },
        region: {
          type: 'string',
          description: 'Region for email delivery: "us-east-1", "eu-west-1", or "sa-east-1".',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'resend__update_domain',
    description: 'Update a sending domain configuration. Backed by PATCH /domains/:id.',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'The domain id.',
        },
        click_tracking: {
          type: 'boolean',
          description: 'Enable or disable click tracking.',
        },
        open_tracking: {
          type: 'boolean',
          description: 'Enable or disable open tracking.',
        },
        tls: {
          type: 'string',
          description: 'TLS setting: "enforced" or "opportunistic".',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'resend__delete_domain',
    description:
      'Remove a sending domain. Breaks email delivery for all messages using that sender. Backed by DELETE /domains/:id.',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'The domain id to delete.',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'resend__verify_domain',
    description:
      'Trigger DNS verification of a domain. Idempotent. Backed by POST /domains/:id/verify.',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'The domain id to verify.',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'resend__create_audience',
    description: 'Create a new audience (contact list). Backed by POST /audiences.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'The audience name (e.g. "Newsletter subscribers").',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'resend__delete_audience',
    description:
      'Delete an audience and all its contacts. Irreversible data loss. Backed by DELETE /audiences/:id.',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'The audience id to delete.',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'resend__create_contact',
    description:
      'Add a contact to an audience. Carries PII (email, name). Backed by POST /audiences/:id/contacts.',
    inputSchema: {
      type: 'object',
      properties: {
        audience_id: {
          type: 'string',
          description: 'The audience id to add the contact to.',
        },
        email: {
          type: 'string',
          description: 'Contact email address.',
        },
        first_name: {
          type: 'string',
          description: 'Contact first name.',
        },
        last_name: {
          type: 'string',
          description: 'Contact last name.',
        },
        unsubscribed: {
          type: 'boolean',
          description: 'Whether the contact is unsubscribed.',
        },
      },
      required: ['audience_id', 'email'],
    },
  },
  {
    name: 'resend__update_contact',
    description: 'Update a contact. Carries PII. Backed by PATCH /contacts/:id.',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'The contact id.',
        },
        first_name: {
          type: 'string',
          description: 'Updated first name.',
        },
        last_name: {
          type: 'string',
          description: 'Updated last name.',
        },
        unsubscribed: {
          type: 'boolean',
          description: 'Updated unsubscribed status.',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'resend__delete_contact',
    description: 'Delete a contact from an audience. Backed by DELETE /contacts/:id.',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'The contact id to delete.',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'resend__create_broadcast',
    description:
      'Create a broadcast (campaign email) for an audience. Starts as draft. Backed by POST /audiences/:id/broadcasts.',
    inputSchema: {
      type: 'object',
      properties: {
        audience_id: {
          type: 'string',
          description: 'The audience id for this broadcast.',
        },
        from: {
          type: 'string',
          description: 'Sender email address (verified domain).',
        },
        subject: {
          type: 'string',
          description: 'Broadcast subject line.',
        },
        html: {
          type: 'string',
          description: 'HTML body of the broadcast.',
        },
        text: {
          type: 'string',
          description: 'Plain text body.',
        },
        reply_to: {
          type: 'array',
          items: { type: 'string' },
          description: 'Reply-to addresses.',
        },
        name: {
          type: 'string',
          description: 'Internal campaign name.',
        },
      },
      required: ['audience_id', 'from', 'subject'],
    },
  },
  {
    name: 'resend__update_broadcast',
    description: 'Update a broadcast (draft). Backed by PUT /broadcasts/:id.',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'The broadcast id.',
        },
        from: {
          type: 'string',
          description: 'Updated sender address.',
        },
        subject: {
          type: 'string',
          description: 'Updated subject line.',
        },
        html: {
          type: 'string',
          description: 'Updated HTML body.',
        },
        text: {
          type: 'string',
          description: 'Updated plain text body.',
        },
        reply_to: {
          type: 'array',
          items: { type: 'string' },
          description: 'Updated reply-to addresses.',
        },
        name: {
          type: 'string',
          description: 'Updated internal campaign name.',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'resend__send_broadcast',
    description:
      'Send a broadcast to its audience. Cardinal risk — mass email delivery. Irreversible. Backed by POST /broadcasts/:id/send.',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'The broadcast id to send.',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'resend__delete_broadcast',
    description:
      'Delete a broadcast. If already sent, only removes the record. If scheduled, cancels it. Backed by DELETE /broadcasts/:id.',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'The broadcast id to delete.',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'resend__describe_zones',
    description:
      'Return the to-zone configuration from the binding metadata (internal_domains, allowlist_domains, allowlist_addresses). Synthetic tool — no upstream API call.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

export const availableTools: readonly McpToolDeclaration[] = [...READ_TOOLS, ...WRITE_TOOLS];

/** The set of write tool names (used by execute.ts and test coverage). */
export const WRITE_TOOL_NAMES = new Set(WRITE_TOOLS.map((t) => t.name));
