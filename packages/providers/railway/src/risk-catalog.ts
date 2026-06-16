/**
 * Railway — risk catalog (TS export, 1:1 with `risk-catalog.yaml`).
 *
 * Source of truth : `.vaubaan/research/providers/railway-ssh.md` §1.4.
 * Spec           : `docs/spec/gateway-risk-model.md` §4.
 *
 * The YAML sibling is the canonical reviewable form ; this TS module is
 * what the runtime imports (no YAML dep at runtime). Keep both in sync —
 * a CI lint in Phase 2 will diff the two structures.
 *
 * 11 risks + 1 fallback. See research §1.5 for the tool × risk coverage
 * matrix. Coverage of every Railway tool by ≥ 1 catalog entry is enforced
 * by `risk-catalog.test.ts`.
 *
 * Conventions :
 *  - Env-scoped risks embed the env discriminator in the *name* part
 *    (`-staging`, `-prod`) — matches the research literal. We do not use
 *    the `<provider>[<env>].<name>` bracket form here (which is reserved
 *    for risks that share a single matches pattern qualified at mint).
 *  - Bulk-variables-replace catches the destructive `replace:true`
 *    codepath via a wildcard slice emitted by the classifier (cf.
 *    `risk-classifier.ts`) ; severity comes from the 6D vector.
 *  - `railway.agent-action` covers the meta-tool `railway__railway-agent` ;
 *    pessimistic catch-all slices are emitted alongside so write-risks
 *    remain mandatory (cf. research §1.6).
 */

import type { RiskCatalog } from '@vaubaan/shared';

export const railwayRiskCatalog: RiskCatalog = {
  provider: 'railway',
  risks: [
    // ─── Reads ─────────────────────────────────────────────────────────────
    {
      id: 'railway.read-account',
      label: 'Lire compte & liste de projets',
      reason: 'Lecture metadata account. Aucun secret.',
      matches: 'railway.account[**].R',
      vector: {
        reversibility: 'reversible',
        blast: 'account',
        data: 'metadata',
        cost: 'free',
        visibility: 'internal',
        persistence: 'stateless',
      },
    },
    {
      id: 'railway.read-runtime',
      label: 'Lire services, déploiements, statuts',
      reason: 'Lecture metadata runtime — pas de payload secret.',
      matches: 'railway.project[**].R',
      vector: {
        reversibility: 'reversible',
        blast: 'env',
        data: 'metadata',
        cost: 'free',
        visibility: 'internal',
        persistence: 'stateless',
      },
    },
    {
      id: 'railway.read-logs',
      label: "Lire les logs d'un déploiement",
      reason:
        "Logs peuvent contenir des secrets imprimés par l'app (DSN, JWT loggés, " +
        'stack-traces). À traiter comme `data` sensible côté audit.',
      matches: 'railway.project[**].environment[**].service[**].deployment[**].logs.R',
      vector: {
        reversibility: 'reversible',
        blast: 'env',
        data: 'data',
        cost: 'free',
        visibility: 'internal',
        persistence: 'stateless',
      },
    },
    {
      id: 'railway.read-variables',
      label: 'Lire les env vars (incluant secrets)',
      reason:
        "Retourne les valeurs en clair par défaut. C'est la principale surface " +
        "d'exfiltration des credentials prod.",
      matches: 'railway.project[**].environment[**].service-var[**].R',
      vector: {
        reversibility: 'reversible',
        blast: 'env',
        data: 'secret',
        cost: 'free',
        visibility: 'internal',
        persistence: 'stateless',
      },
    },

    // ─── Deploys ───────────────────────────────────────────────────────────
    {
      id: 'railway.deploy-staging',
      label: 'Redeploy / accept-deploy sur un env non-prod',
      reason:
        'Reversible : un nouveau deploy peut tout corriger. Pas de communication ' +
        "aval. Coût Railway facturé à l'usage.",
      matches: 'railway.project[**].environment[**].service[**].deployment.W',
      vector: {
        reversibility: 'reversible',
        blast: 'env',
        data: 'data',
        cost: 'moderate',
        visibility: 'internal',
        persistence: 'session',
      },
      acceptable_in_envs: ['staging', 'preview', 'dev'],
    },
    {
      id: 'railway.deploy-prod',
      label: 'Redeploy / accept-deploy sur production',
      reason:
        'Trigger un déploiement public, traffic switch immédiat, potentiel downtime ' +
        '+ propagation aval. Costly à rollback (re-deploy précédent peut prendre ' +
        'quelques minutes).',
      matches: 'railway.project[**].environment[**].service[**].deployment.W',
      vector: {
        reversibility: 'costly',
        blast: 'env',
        data: 'data',
        cost: 'moderate',
        visibility: 'public',
        persistence: 'session',
      },
    },

    // ─── Variables ─────────────────────────────────────────────────────────
    {
      id: 'railway.upsert-variable-staging',
      label: 'Modifier une env var (non-prod)',
      reason:
        "Modif scalaire d'une var. Trigge un redeploy implicite sauf " +
        "skipDeploys=true. Reversible (réécrire l'ancienne valeur).",
      matches: 'railway.project[**].environment[**].service-var[**].W',
      vector: {
        reversibility: 'reversible',
        blast: 'env',
        data: 'secret',
        cost: 'moderate',
        visibility: 'internal',
        persistence: 'posture',
      },
      acceptable_in_envs: ['staging', 'preview', 'dev'],
    },
    {
      id: 'railway.upsert-variable-prod',
      label: 'Modifier une env var en production',
      reason:
        'Posture-shift sur prod. Une valeur erronée peut briser immédiatement le ' +
        'service (Stripe, DB, OAuth).',
      matches: 'railway.project[**].environment[**].service-var[**].W',
      vector: {
        reversibility: 'costly',
        blast: 'env',
        data: 'secret',
        cost: 'moderate',
        visibility: 'internal',
        persistence: 'posture',
      },
    },
    {
      id: 'railway.bulk-variables-replace',
      label: 'Remplacer en bulk toutes les env vars (replace=true)',
      reason:
        'DESTRUCTIF : toute var absente du payload est supprimée. Détecté via ' +
        '`replace:true` côté upsert-variables. Tout env, prod ou pas.',
      matches: 'railway.project[**].environment[**].service-var[*].W',
      vector: {
        reversibility: 'irreversible',
        blast: 'env',
        data: 'secret',
        cost: 'moderate',
        visibility: 'internal',
        persistence: 'posture',
      },
    },

    // ─── Account ───────────────────────────────────────────────────────────
    {
      id: 'railway.create-project',
      label: 'Créer un nouveau projet Railway',
      reason:
        'Account-level write. Pas réversible automatiquement (delete-project ' +
        'requiert UI). Peut générer du coût.',
      matches: 'railway.account[**].project.W',
      vector: {
        reversibility: 'costly',
        blast: 'account',
        data: 'metadata',
        cost: 'unbounded',
        visibility: 'internal',
        persistence: 'posture',
      },
    },

    // ─── Agent (méta-tool) ─────────────────────────────────────────────────
    {
      id: 'railway.agent-action',
      label: 'Invocation railway-agent (méta-tool conversationnel)',
      reason:
        "L'agent upstream peut décider seul quoi muter — pas de classification " +
        'fine possible. Catch-all par construction. Tout usage doit être audité ' +
        'humain (opt-in explicite obligatoire).',
      matches: 'railway.account[**].agent-session.W',
      vector: {
        reversibility: 'costly',
        blast: 'account',
        data: 'secret',
        cost: 'unbounded',
        visibility: 'internal',
        persistence: 'posture',
      },
    },

    // ─── Fallback ──────────────────────────────────────────────────────────
    {
      id: 'railway.uncategorized-write',
      label: 'Écriture Railway non catégorisée',
      reason: 'Catch-all. Si vu en prod, signale qu’une entrée manque au catalogue.',
      matches: 'railway.**.W',
      vector: {
        reversibility: 'costly',
        blast: 'env',
        data: 'data',
        cost: 'moderate',
        visibility: 'internal',
        persistence: 'session',
      },
    },
  ],
};
