/**
 * Gmail — risk catalog (TS export, 1:1 with `risk-catalog.yaml`).
 *
 * Source of truth : `.vaubaan/research/providers/gmail.md` §3.
 * Spec           : `docs/spec/gateway-risk-model.md` §4 + §4bis (scope caps).
 * ADR            : `docs/decisions/scope-caps-amplification-axis.md`.
 *
 * The YAML sibling is the canonical reviewable form ; this TS module is what
 * the runtime imports (no YAML dep at runtime — Vercel does not bundle
 * `.yaml` files in the Lambda). Keep both in sync — a CI test in
 * `tests/unit/risk-catalog-sync.test.ts` diffs the two structures.
 *
 * 14 named risks + 1 fallback = 15 total. RiskId format follows
 * `<provider>.<name>` (cf. shared/src/risk.ts RISK_ID_REGEX). The env
 * qualification is encoded in the binding (mailbox is `envScopable`), not
 * in the RiskId — the runtime resolves the env from the binding.
 *
 * Slice patterns use the DSL declared in policy-engine/src/slice-dsl.ts
 * (no regex, only `[*]` / `[**]` wildcards and `[a,b,c]` lists). Each
 * pattern must match at least one tool's emitted slice — verified by the
 * `risk-catalog.test.ts` coverage lint.
 *
 * Two entries carry `caps` (soft defaults) + `infra_limits` (hard ceilings)
 * per the scope-caps ADR : `gmail.bulk-read` (volume-cardinal) and
 * `gmail.read-from-zone-unknown` (OWASP LLM01 cardinal). The other 12
 * risks stay caps-free at MVP — the org chooses.
 */

import type { RiskCatalog } from '@vaubaan/shared';

export const gmailRiskCatalog: RiskCatalog = {
  provider: 'gmail',
  risks: [
    // ─── READS ─────────────────────────────────────────────────────────────
    {
      id: 'gmail.read-mailbox',
      label: 'Read mailbox metadata (labels, thread headers)',
      reason:
        "Inventory of labels, thread IDs, subjects, sender names. Surface d'attaque " +
        'limitée (metadata) mais sert de baseline read. Also covers the synthetic ' +
        '`gmail__describe_zones` tool returning the binding metadata in read-only form.',
      matches: 'gmail.mailbox.label[**].R',
      vector: {
        reversibility: 'reversible',
        blast: 'single',
        data: 'metadata',
        cost: 'free',
        visibility: 'internal',
        persistence: 'stateless',
      },
    },
    {
      id: 'gmail.read-from-zone-automated',
      label: 'Read messages from automated/notification senders',
      reason:
        'Lectures de notifications (GitHub, Stripe, Vercel...). Faible PII directe mais ' +
        "corps souvent porteur d'URL/markdown injectables (OWASP LLM01). Risk distinct " +
        'pour autoriser un agent "ops" à lire les alertes sans débloquer la ' +
        'correspondance personnelle.',
      matches: 'gmail.mailbox.from-zone[automated].R',
      vector: {
        reversibility: 'reversible',
        blast: 'single',
        data: 'data',
        cost: 'free',
        visibility: 'internal',
        persistence: 'stateless',
      },
    },
    {
      id: 'gmail.read-from-zone-internal',
      label: 'Read messages from internal-domain senders',
      reason:
        'Correspondance entre collègues. Peut contenir secrets, décisions stratégiques, ' +
        'contexte privilégié. Privilégié — distinct du read automated par principe ' +
        'least-privilege.',
      matches: 'gmail.mailbox.from-zone[internal].R',
      vector: {
        reversibility: 'reversible',
        blast: 'single',
        data: 'data',
        cost: 'free',
        visibility: 'internal',
        persistence: 'stateless',
      },
    },
    {
      id: 'gmail.read-from-zone-known-external',
      label: 'Read messages from known external contacts (allowlist)',
      reason:
        "Lectures d'emails de partenaires / clients pré-approuvés (allowlist). Routine " +
        'business, risque relatif faible.',
      matches: 'gmail.mailbox.from-zone[known-external].R',
      vector: {
        reversibility: 'reversible',
        blast: 'single',
        data: 'data',
        cost: 'free',
        visibility: 'internal',
        persistence: 'stateless',
      },
    },
    {
      id: 'gmail.read-from-zone-unknown',
      label: 'Read messages from unknown senders',
      reason:
        "Lectures d'emails dont l'expéditeur n'est ni interne ni allowlisté. Vecteur " +
        'OWASP LLM01 cardinal — prompt injection via le corps du message. Posture forte ' +
        'recommandée + caps serrés.',
      matches: 'gmail.mailbox.from-zone[unknown].R',
      vector: {
        reversibility: 'reversible',
        blast: 'single',
        data: 'data',
        cost: 'free',
        visibility: 'internal',
        persistence: 'stateless',
      },
      caps: {
        items_per_call_max: 10,
        calls_per_minute_max: 20,
        temporal_window_days: 7,
      },
      infra_limits: {
        bytes_per_call_max: 1048576,
      },
    },
    {
      id: 'gmail.read-drafts',
      label: 'Read existing drafts',
      reason:
        'Lecture des brouillons. Peut révéler intentions non-envoyées, versions ' +
        'précédentes de communications externes.',
      matches: 'gmail.mailbox.draft[**].R',
      vector: {
        reversibility: 'reversible',
        blast: 'single',
        data: 'data',
        cost: 'free',
        visibility: 'internal',
        persistence: 'stateless',
      },
    },
    {
      id: 'gmail.read-sensitive-label',
      label: 'Read messages tagged with a sensitive label (financial, legal, HR, ...)',
      reason:
        "Override de zone : qu'importe l'expéditeur, si le thread porte un label " +
        "déclaré sensible par la binding metadata, l'accès est escalé. Garde-fou pour " +
        'les correspondances structurellement privées (paie, juridique, RH, factures).',
      matches: 'gmail.mailbox.sensitive-label[**].R',
      vector: {
        reversibility: 'reversible',
        blast: 'single',
        data: 'pii',
        cost: 'free',
        visibility: 'internal',
        persistence: 'stateless',
      },
    },
    {
      id: 'gmail.bulk-read',
      label: 'Bulk read across the mailbox (non-discriminating query)',
      reason:
        '`search_threads(q="is:unread")` ou query sans `from:`/`to:`/`label:` ' +
        'discriminant peut retourner des centaines de threads en une fois, bypassant le ' +
        'zonage par-message. Marker distinct pour forcer une acceptation explicite.',
      matches: 'gmail.mailbox.bulk-marker.R',
      vector: {
        reversibility: 'reversible',
        blast: 'bulk',
        data: 'data',
        cost: 'free',
        visibility: 'internal',
        persistence: 'stateless',
      },
      caps: {
        items_per_call_max: 50,
        calls_per_minute_max: 5,
        temporal_window_days: 90,
      },
      infra_limits: {
        items_per_call_max: 500,
        bytes_per_call_max: 10485760,
      },
    },

    // ─── WRITES — DRAFTS ───────────────────────────────────────────────────
    {
      id: 'gmail.draft-to-zone-self',
      label: 'Create / modify a draft addressed to self only',
      reason:
        'Brouillon pour soi-même (mémo). Aucun risque de fuite externe tant que le ' +
        "draft n'est pas envoyé. Le MCP officiel Google ne permet PAS le send — donc " +
        'draft = action terminale ici.',
      matches: 'gmail.mailbox.to-zone[self].W',
      vector: {
        reversibility: 'reversible',
        blast: 'single',
        data: 'data',
        cost: 'free',
        visibility: 'internal',
        persistence: 'session',
      },
    },
    {
      id: 'gmail.draft-to-zone-internal',
      label: 'Create / modify a draft addressed to internal recipients only',
      reason:
        'Brouillon destiné à des collègues. Reste interne tant que pas envoyé. Pas de ' +
        "risque d'exfiltration externe.",
      matches: 'gmail.mailbox.to-zone[internal].W',
      vector: {
        reversibility: 'reversible',
        blast: 'env',
        data: 'data',
        cost: 'free',
        visibility: 'team',
        persistence: 'session',
      },
    },
    {
      id: 'gmail.draft-to-zone-allowlist',
      label: 'Create / modify a draft to pre-approved external contacts (allowlist)',
      reason:
        "Brouillon vers contacts externes pré-approuvés (CRM-like). Si le draft n'est " +
        'pas envoyé : risque limité. Si Vaubaan wrappe `send_draft` un jour, ce risk ' +
        'gate naturellement.',
      matches: 'gmail.mailbox.to-zone[allowlist].W',
      vector: {
        reversibility: 'reversible',
        blast: 'env',
        data: 'data',
        cost: 'free',
        visibility: 'team',
        persistence: 'session',
      },
    },
    {
      id: 'gmail.draft-to-zone-external-unbounded',
      label: 'Create / modify a draft to an external recipient not in the allowlist',
      reason:
        "Brouillon vers une adresse externe arbitraire. Vecteur d'exfiltration cardinal " +
        "si le draft est ensuite envoyé. Même sans send, l'existence du draft peut " +
        'leaker des intentions. Jamais acceptable au MVP (acceptable_in_envs: []) — un ' +
        'binding dédié sera ouvert si besoin.',
      matches: 'gmail.mailbox.to-zone[external-unbounded].W',
      vector: {
        reversibility: 'reversible',
        blast: 'account',
        data: 'secret',
        cost: 'free',
        visibility: 'public',
        persistence: 'session',
      },
      acceptable_in_envs: [],
    },

    // ─── WRITES — LABELS ───────────────────────────────────────────────────
    {
      id: 'gmail.label-write',
      label: 'Apply / remove labels on a thread or message (single)',
      reason:
        "Organisation de la boîte. Action UI-level, réversible (re-label). Pas d'impact " +
        'sécuritaire direct, sauf si le label modifié est `SPAM` / `TRASH` / `IMPORTANT` ' +
        '(cf. risk dédié ci-dessous).',
      matches: 'gmail.mailbox.thread[**].label.W',
      vector: {
        reversibility: 'reversible',
        blast: 'single',
        data: 'metadata',
        cost: 'free',
        visibility: 'internal',
        persistence: 'session',
      },
    },
    {
      id: 'gmail.bulk-label-write',
      label: 'Bulk apply / remove labels across many threads',
      reason:
        '`label_thread` sur N threads identifiés via `search_threads(q="...")` large. ' +
        'Risque "silencieux" : un seul call MCP peut affecter des centaines de threads. ' +
        'Marker distinct du single label-write.',
      matches: 'gmail.mailbox.bulk-marker.W',
      vector: {
        reversibility: 'reversible',
        blast: 'bulk',
        data: 'metadata',
        cost: 'free',
        visibility: 'internal',
        persistence: 'session',
      },
    },

    // ─── FALLBACK (required) ───────────────────────────────────────────────
    {
      id: 'gmail.uncategorized-write',
      label: 'Uncategorized Gmail write',
      reason:
        'Catch-all pour les writes non catégorisés. Si Vaubaan étend vers ' +
        '`send_message`, `delete_message`, `create_filter`, ces actions tomberont ici ' +
        "jusqu'à ce qu'un risk dédié soit ajouté au catalogue — fail-loud par design.",
      matches: 'gmail.[**].W',
      vector: {
        reversibility: 'costly',
        blast: 'env',
        data: 'data',
        cost: 'free',
        visibility: 'internal',
        persistence: 'posture',
      },
    },
  ],
};
