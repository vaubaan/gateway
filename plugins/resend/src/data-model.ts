/**
 * Resend data-model — declarative entity graph for the v4 risk-based engine.
 *
 * Spec : docs/spec/resend.md §2.
 *
 * Resend exposes a single plane (`email`). There is no parallel split —
 * domains, transactional emails, audiences/contacts, and broadcasts all
 * live under one account namespace.
 *
 * The `envScopable` axis is carried at the `account` level via the
 * binding's `environment` field — an organisation may create separate
 * Resend accounts (and API keys) for staging vs production, each with
 * its own verified domain. This mirrors the Supabase pattern (one
 * project_ref per env) rather than the Stripe pattern (one key = one mode).
 *
 * Two synthetic entities encode features that Resend's REST surface does
 * NOT expose as queryable resources but that the catalog needs to gate
 * distinctly :
 *
 *   - `to-zone` : recipient identity zone — `internal` / `allowlist` /
 *     `external-unbounded`. Computed from the union of to+cc+bcc
 *     recipients vs the binding metadata (`internal_domains`,
 *     `allowlist_addresses`, `allowlist_domains`). Borrowed from Gmail's
 *     identity-zoning pattern.
 *
 *   - `recipient-count` : blast-radius marker — `single` / `multi` /
 *     `batch`. Distinct from to-zone so the operator can gate bulk sending
 *     independently.
 */

import type { DataModel } from '@vaubaan/shared';

export const dataModel: DataModel = {
  provider: 'resend',
  planes: [
    {
      slug: 'email',
      description:
        'The only Resend plane Vaubaan exposes — the authenticated Resend ' +
        'account and the transactional emails, audiences, contacts, broadcasts, ' +
        'and domains contained within.',
      entities: [
        {
          name: 'account',
          parent: null,
          cardinalities: ['one'],
          envScopable: true,
          description:
            'The Resend account backing the API key. Singleton per binding. ' +
            'Carries the envScopable axis — an org may have separate bindings ' +
            'for staging (test account) vs prod (live account).',
        },
        // ─── Domains cluster ─────────────────────────────────────────────────
        {
          name: 'domain',
          parent: 'account',
          cardinalities: ['bounded'],
          description:
            'A verified sending domain. Bounded — an account typically has a ' +
            'handful of domains (1-5). Cardinal posture-shift surface : adding ' +
            'a domain and verifying it changes what the account can send from.',
        },
        {
          name: 'dns-record',
          parent: 'domain',
          cardinalities: ['bounded'],
          description:
            'Synthetic read-only child of domain — the DKIM/SPF/DMARC DNS ' +
            'records Resend requires the operator to set. Bounded per domain ' +
            '(3-5 records). Read-only from Resend API — the human configures ' +
            'them in their DNS provider.',
        },
        // ─── Transactional email cluster ─────────────────────────────────────
        {
          name: 'email',
          parent: 'account',
          cardinalities: ['unbounded'],
          description:
            'A single transactional email (confirmation, reset, notification). ' +
            'Unbounded history — a busy SaaS can send millions over time. ' +
            'Carries from, to, subject, html/text, status, tags.',
        },
        {
          name: 'batch',
          parent: 'account',
          cardinalities: ['unbounded'],
          description:
            'Synthetic marker for a batch-send call (POST /emails/batch). ' +
            'A batch can contain up to 100 emails. Distinct from single-email ' +
            'to gate bulk-send risk explicitly.',
        },
        // ─── Audience / contact / broadcast cluster ──────────────────────────
        {
          name: 'audience',
          parent: 'account',
          cardinalities: ['bounded'],
          description:
            'A named contact list (newsletter subscribers, beta users, etc.). ' +
            'Bounded — dozens at most in practice.',
        },
        {
          name: 'contact',
          parent: 'audience',
          cardinalities: ['unbounded'],
          description:
            'A subscriber in an audience. Unbounded — a large newsletter can ' +
            'have millions of contacts. Carries PII : email, first_name, ' +
            'last_name, custom properties. RGPD-relevant.',
        },
        {
          name: 'broadcast',
          parent: 'audience',
          cardinalities: ['unbounded'],
          description:
            'A campaign email created for an audience. Can be draft, scheduled, ' +
            'or sent. Unbounded over time — an active marketing team sends ' +
            'weekly or daily.',
        },
        // ─── Synthetic risk-zone markers ─────────────────────────────────────
        {
          name: 'to-zone',
          parent: 'account',
          cardinalities: ['bounded'],
          description:
            'Synthetic marker emitted by the classifier on send calls. The ' +
            'bracketed identifier carries the zone name : `internal` / ' +
            '`allowlist` / `external-unbounded`. Computed from the union of ' +
            'to+cc+bcc recipients vs the binding metadata ' +
            '(`internal_domains`, `allowlist_addresses`, `allowlist_domains`).',
        },
        {
          name: 'recipient-count',
          parent: 'account',
          cardinalities: ['bounded'],
          description:
            'Synthetic marker emitted by the classifier to distinguish ' +
            'single-recipient sends from multi-recipient or batch sends. ' +
            'Brackets carry `single` / `multi` / `batch`. Gates blast-radius ' +
            'amplification distinctly from the to-zone.',
        },
      ],
    },
  ],
};
