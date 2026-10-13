/**
 * Resend data model — the entities a slice path can name (risk-model spec §2).
 *
 * Spec : docs/spec/resend.md §2 ; docs/spec/vaubaan-gateway.md §0
 *        "Resource" (domains and segments are the resources).
 *
 * One plane, `email`. Slices are rooted at the **resources** a mission
 * selects, so the default env resolver finds the ref as the first ident of
 * the path :
 *
 *   domain[<name>]         envScopable — sending surface ; carries the recipient
 *     ├─ dns-record[*]       zone configuration in its metadata
 *     ├─ to-zone[Z]        ★ synthetic : internal | allowlist | external-unbounded
 *     └─ recipient-count[C]★ synthetic : batch (emitted by a batch send only)
 *   segment[<id>]          envScopable — a contact list (Resend's former "audience")
 *     ├─ member[<contact>] ★ synthetic : a contact's membership of the segment
 *     └─ broadcast[<id>]     a campaign targeting the segment (draft → sent)
 *   contact[<id>]          account-level, PII ; belongs to zero or more segments
 *   email[<id>]            a sent transactional email (status read only)
 *
 * ★ Synthetic entities exist for classification only ; Resend exposes no such
 * object. `recipient-count[batch]` carries the bulk-send risk on its own.
 */

import type { DataModel } from '@vaubaan/plugin-sdk';

import { RESEND_PROVIDER } from './resources.ts';

export const resendDataModel: DataModel = {
  provider: RESEND_PROVIDER,
  planes: [
    {
      slug: 'email',
      description:
        'The only Resend plane Vaubaan exposes : the sending domains, the segments ' +
        'with their broadcasts, the account-level contacts and the sent emails.',
      entities: [
        // ─── Sending domains ────────────────────────────────────────────────
        {
          name: 'domain',
          parent: null,
          cardinalities: ['bounded'],
          envScopable: true,
          description:
            'A verified sending domain — a mission resource, labelled with an environment by ' +
            'the owner. Every send is rooted at the domain of its from address. The recipient ' +
            'zone lists (internal_domains, allowlist_domains, allowlist_addresses) are its metadata.',
        },
        {
          name: 'dns-record',
          parent: 'domain',
          cardinalities: ['bounded'],
          description:
            'The DKIM / SPF / DMARC records Resend asks the operator to publish. Read from the ' +
            'API ; the only write is the verification trigger.',
        },
        {
          name: 'to-zone',
          parent: 'domain',
          cardinalities: ['bounded'],
          description:
            'Synthetic marker emitted on every send : the worst recipient zone across to + cc + bcc ' +
            '(internal | allowlist | external-unbounded), computed from the domain resource metadata.',
        },
        {
          name: 'recipient-count',
          parent: 'domain',
          cardinalities: ['bounded'],
          description:
            'Synthetic marker emitted next to the zone by a batch send only (POST /emails/batch) : ' +
            'its one value is batch. Gates blast-radius amplification independently of the zone.',
        },
        // ─── Segments, membership, broadcasts ───────────────────────────────
        {
          name: 'segment',
          parent: null,
          cardinalities: ['bounded'],
          envScopable: true,
          description:
            'A named contact list broadcasts target (Resend renamed audiences to segments in ' +
            'November 2025). A mission resource ; the owner may label it with an environment.',
        },
        {
          name: 'member',
          parent: 'segment',
          cardinalities: ['unbounded'],
          description:
            'Synthetic : a contact as a member of a segment — listing the contacts of a segment, ' +
            'adding one, removing one. The contact itself is the account-level `contact` entity.',
        },
        {
          name: 'broadcast',
          parent: 'segment',
          cardinalities: ['unbounded'],
          description:
            'A campaign email targeting a segment : draft, scheduled or sent. Verb leaves `send` ' +
            'and `delete` separate the irreversible send from drafting.',
        },
        // ─── Account-level entities ─────────────────────────────────────────
        {
          name: 'contact',
          parent: null,
          cardinalities: ['unbounded'],
          description:
            'A subscriber of the account, independent of segments since the 2025 migration. ' +
            'Carries PII : email, first name, last name, custom properties.',
        },
        {
          name: 'email',
          parent: null,
          cardinalities: ['unbounded'],
          description:
            'A sent transactional email : from, to, subject, status, tags. Unbounded history ; ' +
            'its sending domain is not known at classification time, hence account-level.',
        },
      ],
    },
  ],
};
