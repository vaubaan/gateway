/**
 * Representative calls of every tool of the `resend` provider
 * (`ProviderPlugin.examples`) : the samples the plugin's tests run through the
 * kit and the site classifies when it builds (ADR
 * plugin-contract-and-credential-spec, amendment 2026-11-05).
 *
 * The mission holds a prod and a staging sending domain, each with its
 * recipient zones, and a prod and a staging segment : sends reach the
 * internal, allowlisted and outside zones.
 */
import { samplesOn, type Resource, type ToolSamples } from '@vaubaan/plugin-sdk';

import { PROVIDER_ID, TOOL } from './identity.ts';

export const EXAMPLE_PROD_DOMAIN: Resource = {
  provider: PROVIDER_ID,
  ref: 'notifications.acme.com',
  env: 'prod',
  displayName: 'notifications.acme.com',
  metadata: {
    kind: 'domain',
    domain_id: 'dom_prod',
    status: 'verified',
    internal_domains: ['acme.com', 'acme.io'],
    allowlist_domains: ['partner.com'],
    allowlist_addresses: ['Support@Vendor.com'],
  },
};
export const EXAMPLE_STAGING_DOMAIN: Resource = {
  provider: PROVIDER_ID,
  ref: 'staging.acme.dev',
  env: 'staging',
  displayName: 'staging.acme.dev',
  metadata: {
    kind: 'domain',
    domain_id: 'dom_stg',
    internal_domains: ['acme.com'],
    allowlist_domains: [],
    allowlist_addresses: [],
  },
};
export const EXAMPLE_NEWSLETTER: Resource = {
  provider: PROVIDER_ID,
  ref: 'seg_news',
  env: 'prod',
  displayName: 'Newsletter',
  metadata: { kind: 'segment', segment_id: 'seg_news' },
};
export const EXAMPLE_TEST_SEGMENT: Resource = {
  provider: PROVIDER_ID,
  ref: 'seg_test',
  env: 'staging',
  displayName: 'QA list',
  metadata: { kind: 'segment', segment_id: 'seg_test' },
};

/** The mission every sample runs on. */
export const EXAMPLE_MISSION: readonly Resource[] = [
  EXAMPLE_PROD_DOMAIN,
  EXAMPLE_STAGING_DOMAIN,
  EXAMPLE_NEWSLETTER,
  EXAMPLE_TEST_SEGMENT,
];

const FROM = 'Acme <noreply@notifications.acme.com>';
const seg = { segment_id: 'seg_news' };

export const resendExamples: ToolSamples = samplesOn(EXAMPLE_MISSION, {
  [TOOL.getEmail]: [{ args: { id: 'em_1' } }],
  [TOOL.listDomains]: [{ args: {} }],
  [TOOL.getDomain]: [{ args: { domain: 'notifications.acme.com' } }],
  [TOOL.listSegments]: [{ args: {} }],
  [TOOL.getSegment]: [{ args: seg }],
  [TOOL.listContacts]: [{ args: {} }, { args: seg }],
  [TOOL.getContact]: [{ args: { id: 'ct_1' } }, { args: { id: 'bob@example.com' } }],
  [TOOL.listBroadcasts]: [{ args: {} }],
  [TOOL.getBroadcast]: [{ args: { ...seg, id: 'brd_1' } }],
  [TOOL.sendEmail]: [
    { args: { from: FROM, to: ['alice@acme.com'], subject: 'hi' } },
    { args: { from: FROM, to: 'bob@partner.com', subject: 'hi' } },
    { args: { from: 'x@staging.acme.dev', to: ['who@evil.com'], subject: 'hi' } },
    {
      args: {
        from: FROM,
        to: ['alice@acme.com'],
        cc: ['bob@acme.io'],
        bcc: 'carol@acme.com',
        subject: 'hi',
        html: '<p>hi</p>',
        text: 'hi',
        reply_to: ['help@acme.com'],
        headers: { 'X-Entity-Ref-ID': 'ref-1' },
        tags: [{ name: 'kind', value: 'welcome' }],
      },
    },
    {
      args: { from: FROM, to: ['alice@acme.com'], subject: 'hi', attachments: [{}] },
      expectDenied: true,
    },
    {
      args: { from: FROM, to: ['alice@acme.com'], subject: 'hi', headers: { Bcc: 'x@e.io' } },
      expectDenied: true,
    },
  ],
  [TOOL.sendBatchEmails]: [
    { args: { emails: [{ from: FROM, to: ['alice@acme.com'], subject: 'hi' }] } },
    {
      args: {
        emails: [
          { from: FROM, to: ['bob@partner.com'], subject: 'hi' },
          { from: 'x@staging.acme.dev', to: ['who@evil.com'], subject: 'hi' },
        ],
      },
    },
  ],
  [TOOL.createDomain]: [{ args: { name: 'mail.acme.com' } }],
  [TOOL.updateDomain]: [{ args: { domain: 'notifications.acme.com', tls: 'enforced' } }],
  [TOOL.deleteDomain]: [{ args: { domain: 'staging.acme.dev' } }],
  [TOOL.verifyDomain]: [{ args: { domain: 'staging.acme.dev' } }],
  [TOOL.createSegment]: [{ args: { name: 'Beta' } }],
  [TOOL.deleteSegment]: [{ args: { segment_id: 'seg_test' } }],
  [TOOL.createContact]: [
    { args: { email: 'new@example.com' } },
    { args: { email: 'new@example.com', ...seg } },
  ],
  [TOOL.updateContact]: [{ args: { id: 'ct_1', unsubscribed: true } }],
  [TOOL.deleteContact]: [{ args: { id: 'ct_1' } }],
  [TOOL.addContactToSegment]: [{ args: { ...seg, id: 'ct_1' } }],
  [TOOL.removeContactFromSegment]: [{ args: { ...seg, id: 'ct_1' } }],
  [TOOL.createBroadcast]: [
    { args: { ...seg, from: FROM, subject: 'News' } },
    { args: { ...seg, from: FROM, subject: 'News', send: true }, expectDenied: true },
  ],
  [TOOL.updateBroadcast]: [{ args: { ...seg, id: 'brd_1', subject: 'News 2' } }],
  [TOOL.sendBroadcast]: [{ args: { ...seg, id: 'brd_1' } }],
  [TOOL.deleteBroadcast]: [{ args: { ...seg, id: 'brd_1' } }],
  [TOOL.describeZones]: [{ args: {} }],
});
