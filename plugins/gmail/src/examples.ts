/**
 * Representative calls of every tool of the `gmail` provider
 * (`ProviderPlugin.examples`) : the samples the plugin's tests run through the
 * kit (catalog coverage, identifier proof) and the site classifies when it
 * builds (ADR plugin-contract-and-credential-spec, amendment 2026-11-05). One
 * mailbox with its zones (internal domain, allowlisted partner, sensitive
 * labels); ids in the grammar (16 lower-case hexadecimal digits at most).
 */
import { samplesOn, type Resource, type ToolSamples } from '@vaubaan/plugin-sdk';

import { PROVIDER_ID, TOOL } from './identity.ts';

export const MAILBOX = 'me@myorg.com';
export const THREAD = '18c2a9f0e1d2b3a4';
export const MESSAGE = '18c2a9f0e1d2b3a5';

/** The mailbox the samples run on unless they name others. */
export const EXAMPLE_MAILBOX: Resource = {
  provider: PROVIDER_ID,
  ref: MAILBOX,
  displayName: MAILBOX,
  metadata: {
    internal_domains: ['myorg.com'],
    allowlist_addresses: ['partner@vendor.com'],
    allowlist_domains: ['vendor.com'],
    sensitive_labels: ['LEGAL', 'HR'],
    account_email: MAILBOX,
  },
};
/** A second mailbox : a call on two mailboxes names no single one. */
export const EXAMPLE_OTHER_MAILBOX: Resource = {
  provider: PROVIDER_ID,
  ref: 'support@myorg.com',
  displayName: 'support@myorg.com',
};

/** The samples of every tool, ids in the grammar (16 lower-case hexadecimal digits at most). */
export const gmailExamples: ToolSamples = samplesOn([EXAMPLE_MAILBOX], {
  [TOOL.describeZones]: [{ args: {} }],
  [TOOL.searchThreads]: [
    { args: { q: 'from:no-reply@vendor.com' } },
    { args: { q: 'from:colleague@myorg.com' } },
    { args: { q: 'from:other@vendor.com' } },
    { args: { q: 'from:random@random.io' } },
    { args: { q: 'is:unread' } },
    { args: { q: 'label:LEGAL' } },
    { args: { q: 'from:no-reply@vendor.com OR newer_than:3650d' } },
    { args: { q: 'from:colleague@myorg.com -label:LEGAL -label:HR' } },
    { args: { q: 'is:unread' }, resources: [], expectDenied: true },
    {
      args: { q: 'is:unread' },
      resources: [EXAMPLE_MAILBOX, EXAMPLE_OTHER_MAILBOX],
      expectDenied: true,
    },
  ],
  [TOOL.getThread]: [{ args: { id: THREAD } }, { args: {}, expectDenied: true }],
  [TOOL.getAttachment]: [
    { args: { thread_id: THREAD, message_id: MESSAGE, part: '2' } },
    { args: { thread_id: THREAD, message_id: MESSAGE, part: '1.2' } },
    { args: { thread_id: THREAD, message_id: MESSAGE }, expectDenied: true },
    { args: { thread_id: THREAD, message_id: MESSAGE, part: '0' }, expectDenied: true },
  ],
  [TOOL.listDrafts]: [{ args: {} }],
  [TOOL.createDraft]: [
    { args: { to: [MAILBOX], subject: 's', body: 'b' } },
    { args: { to: ['colleague@myorg.com'], subject: 's', body: 'b' } },
    {
      args: { to: ['partner@vendor.com'], cc: 'Me <me@myorg.com>', subject: 's', body: 'b' },
    },
    // An external recipient, and a recipient that does not parse, refuse the call.
    { args: { to: ['stranger@evil.example'], subject: 's', body: 'b' }, expectDenied: true },
    {
      args: { to: ['evil@evil.example, colleague@myorg.com'], subject: 's', body: 'b' },
      expectDenied: true,
    },
  ],
  [TOOL.sendMessage]: [
    { args: { to: [MAILBOX], subject: 's', body: 'b' } },
    { args: { to: ['colleague@myorg.com'], subject: 's', body: 'b' } },
    { args: { to: ['partner@vendor.com'], bcc: [MAILBOX], subject: 's', body: 'b' } },
    // Unlike a draft, a send to an external recipient is a risk a mission may accept.
    { args: { to: ['stranger@evil.example'], subject: 's', body: 'b' } },
    { args: { subject: 's', body: 'b' }, expectDenied: true },
    {
      args: { to: ['evil@evil.example, colleague@myorg.com'], subject: 's', body: 'b' },
      expectDenied: true,
    },
  ],
  [TOOL.sendDraft]: [
    { args: { id: MESSAGE, to: ['colleague@myorg.com'] } },
    { args: { id: MESSAGE, to: ['stranger@evil.example'] } },
    { args: { to: ['colleague@myorg.com'] }, expectDenied: true },
    { args: { id: MESSAGE }, expectDenied: true },
  ],
  [TOOL.listLabels]: [{ args: {} }],
  [TOOL.createLabel]: [
    { args: { name: 'Clients 2026' } },
    { args: { name: 'Projets/Été' } },
    { args: { name: 'TRASH' }, expectDenied: true },
    { args: { name: '[Gmail]/Archive' }, expectDenied: true },
  ],
  [TOOL.labelMessage]: [{ args: { thread_id: THREAD, message_id: MESSAGE, label: 'STARRED' } }],
  [TOOL.unlabelMessage]: [{ args: { thread_id: THREAD, message_id: MESSAGE, label: 'STARRED' } }],
  [TOOL.labelThread]: [
    { args: { thread_id: THREAD, label: 'STARRED' } },
    { args: { label: 'STARRED' }, expectDenied: true },
    { args: { thread_id: THREAD, label: 'TRASH' }, expectDenied: true },
  ],
  [TOOL.unlabelThread]: [{ args: { thread_id: THREAD, label: 'STARRED' } }],
});
