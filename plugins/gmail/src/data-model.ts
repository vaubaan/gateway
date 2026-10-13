/**
 * Gmail data-model — declarative entity graph of the `mailbox` plane.
 *
 * Spec     : docs/spec/gateway-risk-model.md §2.
 * Handbook : docs/handbook/providers/gmail.md.
 *
 * Gmail exposes a single plane (`mailbox`) — there is no parallel split into
 * inbox / sent / drafts ; those are *labels* in Gmail's own model, not
 * planes. The distinctive feature of this data model is the
 * *identity-based zoning* : a message's risk profile depends on the
 * **sender domain** (or recipient set), not on the technical containment.
 * Vaubaan encodes that axis via 4 synthetic entities (`from-zone`,
 * `to-zone`, `bulk-marker`, `sensitive-label`) under `mailbox` — these are
 * NOT real Gmail entities, they are markers emitted by the classifier when
 * a call's args reveal a zone.
 *
 * Cardinalities follow the handbook table. `envScopable` is
 * set on the plane root (`mailbox`) : a Gmail mailbox resource can carry an
 * `env` label (e.g. `prod` for the company-wide mailbox vs `staging` for a
 * test mailbox), even though Gmail itself has no native env concept.
 *
 * This data-model is the canonical source for :
 *   - the mermaid diagram rendered into the handbook (spec §2),
 *   - the catalog's `matches` patterns (each pattern must refer to entity
 *     slugs declared here — lint at CI),
 *   - the lint that every MCP tool exposed by this provider classifies
 *     into at least one slice rooted at a declared entity.
 */

import type { DataModel } from '@vaubaan/plugin-sdk';

export const gmailDataModel: DataModel = {
  provider: 'gmail',
  planes: [
    {
      slug: 'mailbox',
      description:
        'The only Gmail plane Vaubaan exposes — the authenticated user account ' +
        'and the threads/messages/labels/drafts contained within. Synthetic risk-' +
        'zone markers (`from-zone`, `to-zone`, `bulk-marker`, `sensitive-label`) ' +
        'are entities for slice-matching purposes only, not real Gmail resources.',
      entities: [
        {
          name: 'account',
          parent: null,
          cardinalities: ['one'],
          description:
            'The Gmail account / OAuth-authenticated user backing the bearer used by ' +
            'Vaubaan. Singleton per connection (one connection = one Gmail account ; a mission ' +
            'with several mailboxes is denied until multi-account is decided).',
        },
        {
          name: 'mailbox',
          parent: 'account',
          cardinalities: ['one'],
          envScopable: true,
          description:
            'Singleton implicit per account — Gmail does not expose multiple "mailboxes" ' +
            'per account. Carries the env label of the resource (e.g. a company may want ' +
            'separate connections for the legal team mailbox vs the support inbox).',
        },
        {
          name: 'label',
          parent: 'mailbox',
          cardinalities: ['bounded'],
          description:
            'A Gmail label — system (INBOX, SENT, SPAM, TRASH, IMPORTANT, ...) or user-' +
            'defined. Bounded in practice : a few dozen at most per account.',
        },
        {
          name: 'thread',
          parent: 'mailbox',
          cardinalities: ['unbounded'],
          description:
            'A conversation grouping. Unbounded history — a busy inbox can carry ' +
            'hundreds of thousands of threads.',
        },
        {
          name: 'message',
          parent: 'thread',
          cardinalities: ['bounded'],
          description:
            'A single email inside a thread. Bounded per thread (a few units to a few ' +
            'dozen). Carries the bytes, headers, body, attachments.',
        },
        {
          name: 'attachment',
          parent: 'message',
          cardinalities: ['bounded'],
          description:
            'A binary blob attached to a message. Bounded per message (Gmail caps the ' +
            'total at 25 MB per message).',
        },
        {
          name: 'draft',
          parent: 'mailbox',
          cardinalities: ['bounded'],
          description:
            'An unsent message held by Gmail in the drafts folder. Bounded (dozens at ' +
            'most in practice). NOT a child of `thread` — drafts have their own id ' +
            'space on the Gmail API.',
        },
        // ─── Synthetic risk-zone markers (NOT real Gmail entities) ──────────
        {
          name: 'from-zone',
          parent: 'mailbox',
          cardinalities: ['bounded'],
          description:
            'Synthetic marker emitted by the classifier when a read call reveals the ' +
            'sender of a message. The bracketed identifier carries the zone name : ' +
            '`automated` / `internal` / `known-external` / `unknown`. Classification ' +
            'rule lives in `classify.ts` and reads the resource metadata ' +
            '`internal_domains` + `allowlist_domains` + `allowlist_addresses`.',
        },
        {
          name: 'to-zone',
          parent: 'mailbox',
          cardinalities: ['bounded'],
          description:
            'Synthetic marker emitted by the classifier on draft / send calls. The ' +
            'bracketed identifier carries the zone name : `self` / `internal` / ' +
            '`allowlist` / `external-unbounded`. Computed from the union of to+cc+bcc ' +
            'recipients vs the resource metadata.',
        },
        {
          name: 'bulk-marker',
          parent: 'mailbox',
          cardinalities: ['one'],
          description:
            'Synthetic singleton marker emitted by the classifier when a call may ' +
            'touch many items (a search_threads query not bounded by a positive ' +
            '`from:<address>` clause). Distinct from the per-item zone markers so ' +
            'the operator confirms bulk-amplification explicitly.',
        },
        {
          name: 'sensitive-label',
          parent: 'mailbox',
          cardinalities: ['bounded'],
          description:
            'Synthetic marker emitted by the classifier when a call may read, apply ' +
            'or remove a label listed in the resource metadata `sensitive_labels` ' +
            '(e.g. FINANCIAL, LEGAL, HR, PERSONAL). Overrides the from-zone ' +
            'classification — a sensitive label gates the read regardless of who ' +
            'the sender is. The identifier is the label name, or `*` when the ' +
            'label is unknown before the fetch.',
        },
      ],
    },
  ],
};
