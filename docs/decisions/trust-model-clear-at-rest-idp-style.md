---
title: Trust model — IdP-style, clear-in-memory, encrypted at-rest
status: accepted
date: 2026-05-22
tracks:
  - docs/spec/mcp-proxy.md
---

# Trust model — IdP-style, clear-in-memory, encrypted at-rest

## Contexte

V3 reposait sur un trust model **zero-knowledge** : Vaubaan Core ne voyait
jamais les credentials provider en clair. Les creds étaient chiffrés côté
client (Runner) avec une clé dérivée d'un keyring user, et déchiffrés
_uniquement_ sur le laptop dev / Runner.

La v4 introduit le **MCP Gateway** : pour filtrer sémantiquement et
forwarder un call upstream, Vaubaan Core doit **lui-même** déchiffrer le
token provider, signer un JWT (GitHub) ou tirer un refresh dance
(Supabase), puis émettre la requête HTTPS. **C'est mathématiquement
incompatible avec le ZK.**

Question : on s'engage sur quel trust model alors ?

## Décision

**Trust model "IdP-style"**, équivalent fonctionnel à Okta / Auth0 /
Cloudflare Access / Stripe Connect :

- Les ProviderAdmin tokens sont **chiffrés at-rest** via une KMS séparée
  (Supabase Vault — la KEK est gérée par Supabase et **jamais accessible
  à l'app Vauban**).
- À chaque MCP call autorisé, le gateway **déchiffre en mémoire** le
  token long-lived nécessaire, mint le token éphémère upstream, fait
  l'appel, puis **libère immédiatement** les tokens de mémoire (pas de
  cache persistant en clair — sauf cache Redis 50min pour le GitHub
  installation token, qui est lui-même éphémère 1h).
- L'opérateur Vaubaan (la personne qui gère l'infra Vercel / Supabase de
  vaubaan.com) a accès en clair aux tokens _en mémoire d'exécution_
  pendant qu'un call est en cours. C'est inévitable.

L'org admin **accepte ce modèle de confiance** quand il connecte un
provider — c'est la même proposition de confiance qu'avec Okta, Stripe
Connect, etc.

Posture sécurité opérationnelle :

- Encryption at-rest via Supabase Vault (KEK gérée par Supabase).
- Audit immutable côté DB (append-only depuis l'app).
- Pas de logs en clair des tokens (logging filtre les champs sensibles).
- Rotation périodique des secrets app Vaubaan (App privkey GitHub, OAuth
  client secrets Vercel/Supabase, encryption keys app-level).
- Isolation envs dev/staging/prod : 3 projets Supabase distincts, 3
  Vercel projects, 3 GitHub Apps distinctes (vauban-dev, vauban-staging,
  vauban-prod).
- Objectif SOC 2-like dès v1.5 (sans certif tant qu'on n'a pas la
  traction client).

## Conséquences

**Positives :**

- **Modèle de confiance lisible.** "Vaubaan Core est un IdP, tu nous fais
  confiance pour agir à ta place chez le provider, ou tu n'utilises pas
  Vauban." Pas d'ambiguïté.
- **Filtrage sémantique possible.** Le gateway peut effectivement
  inspecter `(tool, arguments)` et appliquer une policy. C'est _toute_
  la valeur produit.
- **UX onboarding inchangée par le trust model.** OAuth/App install
  ressemble à n'importe quel autre IdP.
- **Conformité usuelle des SaaS B2B.** SOC 2 / ISO 27001 / GDPR ont des
  cases process bien définies pour ce modèle.

**Négatives / coûts assumés :**

- **Compromis Vaubaan Core = compromis de tous les ProviderAdmins de
  toutes les Orgs.** C'est _le_ worst-case. Mitigations seulement —
  pas de mitigation absolue.
  - Encryption at-rest : protège la DB _au repos_ (cold storage compromis,
    backup volé, etc.). Ne protège pas un attaquant qui pwn l'app
    runtime (il a la KEK via Supabase Vault → il peut tout déchiffrer).
  - Audit immutable : permet la _détection_ post-compromission, pas la
    prévention.
  - Rotation : limite la fenêtre d'exploitation des secrets exfiltrés.
- **Pas de garantie cryptographique pour l'org admin.** Il doit accepter
  notre process sécu opérationnel. Aucun mécanisme cryptographique ne
  peut le rassurer (sauf à revenir au ZK, qui interdit le filtrage).
- **Pas convenable pour orgs banking / défense / santé regulated qui
  exigent ZK ou HSM côté client.** Cible MVP = startups et SMB.
  Clients regulated = roadmap dédiée (per-org HSM, etc.) hors MVP.

## Alternatives rejetées

- **Réintroduire un ZK partiel** (ex: filtrer sur le `tool_name` mais pas
  sur les arguments, et déchiffrer les tokens uniquement côté client
  Runner). Rejeté : ça ramène le Runner, qui est précisément ce qu'on
  retire en v4 ; et ça réduit drastiquement la valeur du filtrage (la
  plupart des decisions intéressantes sont _sur les arguments_).
- **HSM cloud (AWS CloudHSM, Azure DH).** Rejeté en MVP : coût mensuel
  élevé, pas justifié pour le profil client MVP. Reconsidérable en v2+
  pour les clients regulated.
- **Hold the tokens chiffrés et déléguer le déchiffrement à un service
  séparé** (ex: HashiCorp Vault hébergé séparément). Rejeté en MVP :
  ajoute un service à opérer, ne change pas fondamentalement le modèle
  (le service de déchiffrement _a_ lui-même les keys).
