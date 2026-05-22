---
title: Infisical comme SecretManager built-in en v1 ; Vault et 1Password en stubs
status: accepted
date: 2026-05-21
author: rpelissier
tracks: []
---

# Infisical en v1, Vault et 1Password reportés en stubs

## Contexte

La spec §3.1 introduit la table `secret_managers` et §5.2 définit
l'interface `SecretManager` : un _store opaque_ qui ne voit que des
sealed_blob multi-recipients (le chiffrement vit dans le browser, cf.
ADR `crypto-libsodium-sealed-box-multi-recipient.md`).

L'intérêt d'avoir une indirection "SecretManager" — au lieu de stocker
les blobs directement dans `resource_access.sealed_blob` — est triple :

1. **BYO storage** : une org veut souvent garder le contrôle de
   _où_ vivent ses secrets, même chiffrés (politique compliance, audit
   forensique chez le storer).
2. **Eat-your-own-dog-food** : Vauban a besoin de tester l'interface
   sur un vrai backend (pas un mock), sinon la generalité du contrat
   est purement théorique.
3. **Spec §5.2 share** : la même interface est consommée par le CAR
   (coding-agent-runner.md §8.2-§8.3). Si on n'avait pas d'abstraction,
   le CAR devrait taper Postgres directement, ce qui casse l'isolation
   d'environnement Core / Runner.

En v1 il faut choisir **un** backend concret livré clé-en-main, et
documenter les autres comme stubs `throw NotImplemented`.

## Décision

On livre **Infisical** (`https://infisical.com`) comme l'unique
`SecretManager` concret en v1 :

- **Mode** : BYO workspace. L'org connecte son workspace Infisical Cloud
  (Free tier OK) ou self-hosted ; Vauban ne gère pas l'hébergement.
- **Auth** : token machine-identity scopé au workspace, lui-même stocké
  en `secret_managers.auth_sealed_blob` sealed multi-recipient pour
  `org_admins ∪ runner_pk`. Première opération SM = unseal côté browser
  → token transitoirement en mémoire.
- **Storage** : chaque `(resourceId, accessKey)` est rangé sous un path
  Infisical canonique `/<resourceId>/<accessKey>` ; la valeur est le
  bundle JSON `SealedBlob` (§4.3) lui-même.

Les autres plugins déclarés au catalogue (`vault`, `1password`) restent
des **stubs** : leur entry exists dans la table `secret_managers.kind`
mais `get/put/list/revoke` lèvent `NotImplemented` jusqu'à ce qu'une
phase ultérieure les implémente.

L'implémentation concrète n'est pas livrée en v1 init (cf. build plan
`out_of_scope_for_init` phase 5). Cette ADR formalise le choix au
_moment_ du bootstrap pour que les tests d'intégration §12.2 puissent
être conçus contre cette cible.

## Conséquences

### Positives

- **Tier gratuit éprouvé** : Infisical Cloud est gratuit pour environ 5 users et 10 environnements, suffisant pour l'org de test E2E (`vauban-e2e`) sans engager de coût récurrent.
- **API REST simple** : un `POST /api/v3/secrets/raw/{name}` suffit
  pour le put ; pas de SDK lourd à embarquer. On peut écrire le plugin
  en ~200 LOC.
- **Self-host disponible** : une org regulated peut auto-héberger
  Infisical sans changement de code, juste en pointant `endpoint` vers
  son instance.
- **MIT license** : pas de tracker propriétaire qui fait Vauban opt-in
  à un commerciale, contrairement à 1Password.
- **Interface §5.2 immédiatement testable** : le contrat `SecretManager`
  arrête d'être théorique → les tests d'intégration §12.2 peuvent
  vraiment exercer le round-trip seal/unseal.

### Négatives / contraintes

- **Dépendance externe Cloud par défaut** : sans Infisical self-host,
  l'org dépend de la disponibilité de `infisical.com`. Un outage
  Infisical bloque temporairement les sessions Coding qui demandent
  un Access fresh (le CAR sait cacher localement, cf. spec
  coding-agent-runner.md §8.3, mais le CRM seul n'a pas de cache).
- **Couplage du token machine-identity** : si l'auth_sealed_blob est
  perdu (tous les recipients ont changé sans re-seal), il faut
  régénérer le token côté Infisical et re-injecter. Pas de récupération
  côté Vauban.
- **Pas de "managed crypto" backend en v1** : les org qui voudraient
  Vault Transit ou GCP KMS attendent v2+ (spec §4.8). Acceptable car
  ces modèles changent le TCB et méritent leur propre ADR.

## Alternatives rejetées

### Stocker directement dans `resource_access.sealed_blob` (pas de SM externe)

Plus simple, moins de dépendance. Rejet :

- Casse la promesse BYO storage (spec §5.2).
- Force le CAR à taper Postgres / API CRM directement → couplage fort
  qu'on veut justement éviter (l'org Runner doit pouvoir refresh son
  cache via la même interface §8.2).
- Aucun bénéfice à long terme : la table `secret_managers` reste
  nécessaire pour les orgs Vault/1Password.

### HashiCorp Vault en v1

Backend mature, mais :

- Self-host obligatoire (Vault Cloud n'est plus offert gratuitement
  depuis 2024). L'org doit déjà tenir un Vault avant d'utiliser
  Vauban → onboarding lourd.
- L'API Vault KV-v2 colle bien à notre besoin, mais l'expérience d'op
  (unseal de Vault, policies HCL) ajoute un knowledge cost
  disproportionné pour un "premier utilisateur".

### 1Password Connect en v1

Très propre côté DX (UI familière), mais :

- 1Password Connect demande un déploiement self-host (sidecar Docker) ;
  même problème de friction qu'avec Vault.
- License commerciale Business + ; pas de tier free pour le test E2E.
- L'API SCIM-like est moins idiomatique pour des blobs binaires.

### Stockage S3-compatible (Minio, R2) avec préfixes par org

Pas un "secret manager" : c'est juste un blob store. Aucun audit
serveur-side du qui-lit-quoi, et pas d'API d'identité par workspace.
Sortie de scope §5.2.

### Build own SM

Cher (audit, ops), aucun ROI face à Infisical OSS.

## Références

- `docs/spec/cloud-resource-manager.md` §3.1 (`secret_managers` schema),
  §4.8 (backends à crypto serveur-side), §5.2 (contrat
  `SecretManager`).
- spec `docs/spec/coding-agent-runner.md` §8.2-§8.3 (côté consumer).
- Infisical OSS : https://github.com/Infisical/infisical (MIT).
- ADR `crypto-libsodium-sealed-box-multi-recipient.md` (le SM ne voit
  jamais le cleartext de toute façon).
