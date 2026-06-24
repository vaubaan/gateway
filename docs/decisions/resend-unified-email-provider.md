---
title: Resend comme provider email outbound unifie (transactionnel + broadcast)
status: accepted
date: 2026-06-23
author: rpelissier
---

# Resend comme provider email outbound unifie

## Contexte

Le gateway Vaubaan expose des providers cloud via un modele de risque
v4 (cf. [[pivot-to-risk-based-model]]). A date du 2026-06-23, neuf
providers sont integres (GitHub, Vercel, Supabase, Railway, SSH,
Upstash Redis, Stripe, Gmail, Resend). Parmi eux, **deux couvrent
l'email** mais sur des axes complementaires :

- **Gmail** (provider 6, modelise 2026-06-18) couvre l'**inbound** :
  lecture de mailbox, threads, labels, drafts. Son axe cardinal est
  l'identite de l'expediteur (`from-zone`) pour gater la lecture de
  messages potentiellement dangereux (OWASP LLM01). Gmail ne couvre
  pas l'envoi — Google a volontairement retire `send_message` du MCP
  officiel, et Vaubaan s'aligne sur cette decision au MVP.

- Il manquait un provider **outbound** couvrant trois cas d'usage
  concrets :
  1. **Email transactionnel** — confirmation, password reset,
     magic-link, notification d'evenement. Un agent qui orchestre un
     deploy ou un lifecycle utilisateur doit pouvoir envoyer des emails
     cibles via un domaine verifie.
  2. **Broadcast / newsletter** — product update, changelog, campagne
     marketing. Un agent qui pilote un pipeline de contenu doit pouvoir
     creer, planifier et envoyer des campagnes a des audiences curees.
  3. **Gestion de domaines** — ajouter un domaine d'envoi, declencher
     la verification DNS (DKIM, SPF, DMARC). Un agent de provisioning
     doit pouvoir configurer l'infra email d'un nouveau projet.

Le choix du provider outbound devait satisfaire plusieurs contraintes
issues du risk-model v4 :

- **Paste-credentials** : pas d'OAuth complex, une API key suffit
  (pattern deja valide par Stripe, cf. [[mint-install-token-credential]]).
- **Identity-zoning** : le risque cardinal d'un provider outbound
  n'est pas _qui envoie_ (c'est fixe par le domaine verifie) mais
  _a qui on envoie_. Le modele doit permettre un gating par zone
  destinataire (internal / allowlist / external-unbounded), inspire
  du pattern Gmail.
- **Couverture transactionnel + broadcast** dans un seul provider pour
  eviter la double modelisation (deux catalogs, deux classifiers, deux
  adapters).
- **Surface API raisonnable** — assez de tools pour couvrir les
  use-cases sans exploser la surface d'attaque.

## Decision

**Resend est le provider outbound email unique du gateway Vaubaan.
Gmail reste le provider inbound. Les deux sont complementaires, pas
concurrents.**

Choix structurants :

1. **Un seul provider couvre transactionnel + broadcast.** Resend
   expose a la fois `POST /emails` (transactionnel) et la Broadcast
   API (`/audiences`, `/contacts`, `/broadcasts`) sous la meme API key.
   Pas besoin de deux providers separes (un pour le transactionnel, un
   pour la newsletter).

2. **Pattern paste-credentials (API key `re_*`).** L'operateur colle
   sa cle API Resend dans l'UI Vaubaan. Pas d'OAuth, pas de refresh
   token, pas de callback URL. La cle est stockee chiffree dans
   `provider_admins.access_token_encrypted` via Supabase Vault. Meme
   pattern que Stripe.

3. **Identity-zoning sur l'axe destinataire (`to-zone`).** Le
   classifier Resend calcule la zone a partir de l'union des
   recipients (`to` + `cc` + `bcc`) vs la binding metadata
   (`internal_domains`, `allowlist_domains`, `allowlist_addresses`).
   Worst-case wins : un seul destinataire `external-unbounded` parmi
   20 `internal` fait passer la zone a `external-unbounded`. Pattern
   emprunte a Gmail (`from-zone`) mais applique a l'axe destinataire.

4. **`send-email-external-unbounded` bloque en prod.** Le risk
   portant `acceptable_in_envs: ['staging', 'dev']`, un token lie a
   un binding prod ne peut jamais accepter l'envoi vers un destinataire
   arbitraire au mint. C'est le circuit-breaker structurel contre
   l'exfiltration de donnees via agent compromis.

5. **Denial structurel des attachments en v1.** Le classifier
   short-circuite avec `{ denied: 'attachments not supported in v1' }`
   si `args.attachments` est non-vide. Les attachments sont un vecteur
   d'exfiltration binaire — ils seront supportes en Phase 2 avec le
   cap `bytes_per_call_max` (cf. [[scope-caps-amplification-axis]]).

6. **Caps et infra_limits sur les actions bulk.** `send-batch` (100
   emails/call max, 5/min, 50/session) et `broadcast-send` (1/min,
   5/session) portent des caps par defaut et des infra_limits. Le
   `broadcast-send` est le risk le plus contraint du provider —
   chaque appel delivre potentiellement des milliers d'emails
   irreversiblement.

## Consequences

### Positives

- **Un seul provider couvre transactionnel + newsletter.** Pas besoin
  de SendGrid pour les emails transactionnels ET Mailchimp/Loops pour
  les newsletters. Un seul catalog de risques (15 nommes + 1
  fallback), un seul classifier, un seul adapter, une seule binding
  metadata shape.

- **Le risk-model v4 couvre bien l'outbound email.** 25 tools MCP
  (9 reads + 16 writes) mappes sur 16 risks avec vecteur 6D raisonne.
  Les trois axes cardinaux (to-zone, recipient-count, broadcast
  bypass) permettent un gating fin sans exploser le nombre de risks.

- **Complementarite propre avec Gmail.** Resend = outbound (envoyer),
  Gmail = inbound (lire + drafter). Un operateur peut minter un token
  avec les deux providers sans confusion de perimetre. Les deux
  partagent le concept d'identity-zoning mais sur des axes differents
  (to-zone pour Resend, from-zone pour Gmail).

- **DX moderne.** L'API Resend est simple (REST JSON, API key, pas
  de SDK lourd). La doc est excellente. Le pricing est transparent
  (par email envoye). Le pattern paste-credentials est le plus simple
  de tous les providers Vaubaan.

- **RGPD modelise.** Le risk `read-audiences` (contacts PII) est
  distinct du `read-email-status` (metadata). Un agent peut verifier
  le statut d'envoi sans avoir acces a la base de contacts.

### Negatives / contraintes

- **Pas de webhooks en v1.** Les evenements de livraison (delivered,
  bounced, complained) ne sont pas captures par le gateway. L'agent
  ne peut pas reagir a un bounce en temps reel. Deferred a Phase 2.

- **Pas de templates en v1.** Les agents composent le HTML
  directement. Si un operateur veut des templates, il les gere cote
  Resend et les reference par ID (non modelise).

- **Pas de scheduling en v1.** `scheduled_at` (emails et broadcasts)
  ajoute une dimension temporelle au blast control qui necessite
  d'abord le cap model (cf. [[scope-caps-amplification-axis]]). Phase 2.

- **Pas d'attachments en v1.** Denial structurel au classifier. Les
  agents qui doivent envoyer des pieces jointes (factures PDF,
  rapports) sont bloques. Phase 2 avec `bytes_per_call_max`.

- **Env-separation par comptes distincts.** Resend n'a pas de mode
  test/live natif (contrairement a Stripe). La separation staging/prod
  requiert deux comptes Resend et deux API keys — plus de friction
  operationnelle que Stripe, mais alignee sur le pattern Supabase.

- **Dependance a un SaaS tiers.** Si Resend disparait ou change
  radicalement son API, la migration touchera le catalog, le
  classifier, et l'adapter. Risque accepte : l'API Resend est stable,
  bien documentee, et le pattern REST est standard (migration vers un
  autre provider serait un changement d'adapter, pas de modele).

## Alternatives rejetees

### SendGrid (Twilio)

API legacy complexe, surface API tres large (templates, webhooks,
subusers, IP pools, suppressions, stats). Le risk-model devrait
couvrir une surface d'attaque bien plus large sans gain fonctionnel
pour les use-cases cibles. Le SDK est lourd et la DX datee
(v3 API avec des concepts comme `personalizations` qui complexifient
un simple envoi). Le pricing est opaque (plans tiers avec des features
gatees). Le pattern paste-credentials fonctionne, mais la surface a
modeler est disproportionnee pour un MVP.

### AWS SES

Necessite un binding AWS complet (IAM user ou role, access key +
secret key, region). Pas compatible avec le pattern paste-credentials
simple (une seule API key). La modelisation devrait integrer les
concepts IAM AWS (policies, roles, regions), ce qui croise le
perimetre d'un futur provider AWS generique. L'envoi d'email via SES
est un sous-ensemble d'un provider cloud complet — pas le bon niveau
d'abstraction pour un provider email dedie.

### Resend (transactionnel) + Loops (broadcast, separe)

Double la modelisation pour un gain marginal. Loops couvre le
broadcast/newsletter avec une UX orientee marketing, mais Resend
couvre deja le broadcast via sa Broadcast API native. Deux providers
= deux catalogs de risques, deux classifiers, deux adapters, deux
binding metadata shapes. Le cout de maintenance double sans benefice
fonctionnel clair — Resend Broadcast couvre le use-case newsletter
pour un agent IA (creer une audience, ajouter des contacts, drafter
une campagne, envoyer).

### Mailgun

Meme niche que Resend (API email pour developpeurs) mais DX
inferieure — la doc est moins claire, le SDK est plus lourd, le
dashboard est moins intuitif. Le pricing est moins transparent
(plans par paliers, features cachees derriere les tiers). L'API
est fonctionnellement equivalente a Resend pour les use-cases cibles
mais avec plus de friction. Pas de Broadcast API native — le
broadcast passerait par des mailing lists Mailgun dont la
modelisation est plus complexe.

### Postmark

Excellent pour le transactionnel (DX comparable a Resend, deliverabilite
de reference), mais pas de Broadcast API. Couvrirait le use-case 1
(transactionnel) mais pas le 2 (newsletter/broadcast). Necessiterait
un second provider pour le broadcast — retombe sur le probleme de la
double modelisation.

### Ne rien faire (statu quo)

Le gateway n'aurait aucune capacite d'envoi email. Les agents
devraient passer par des mecanismes ad-hoc (webhook vers un service
externe, appel direct a une API email sans gating risk-based).
Inacceptable : l'email est un canal cardinal pour un SaaS
(confirmations, notifications, newsletters) et l'absence de gating
risk-based sur l'envoi est un trou de securite (un agent compromis
pourrait envoyer n'importe quoi a n'importe qui via un appel direct).

## References

- Spec Resend : [`docs/spec/resend.md`](../spec/resend.md)
- Handbook Resend :
  [`docs/handbook/providers/resend.md`](../handbook/providers/resend.md)
- Handbook Gmail :
  [`docs/handbook/providers/gmail.md`](../handbook/providers/gmail.md)
- Risk catalog :
  [`packages/providers/resend/src/risk-catalog.yaml`](../../packages/providers/resend/src/risk-catalog.yaml)
- ADR pivot risk-based :
  [`docs/decisions/pivot-to-risk-based-model.md`](./pivot-to-risk-based-model.md)
- ADR scope-caps :
  [`docs/decisions/scope-caps-amplification-axis.md`](./scope-caps-amplification-axis.md)
- ADR paste-credentials :
  [`docs/decisions/mint-install-token-credential.md`](./mint-install-token-credential.md)
