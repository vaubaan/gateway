---
title: Provider risk-model handbooks — index
status: current
date: 2026-06-15
---

# Provider risk-model handbooks

Cinq documents de modélisation v4 risk-based — un par provider Vaubaan.
Chacun couvre la même structure (cf. spec
[`gateway-risk-model.md`](../../spec/gateway-risk-model.md)) :

1. **Data-model** — entités du plane + cardinalités + diagram mermaid
2. **Mapping tool → slice** — pour chaque tool MCP, quelle slice est émise au call
3. **Risk catalog** — YAML/TS canonique avec 6D vector + `acceptable_in_envs` quand pertinent
4. **Lint coverage** — matrice tool × risk (chaque tool couvert par ≥1 risk)
5. **Edge cases** — décisions de classification non-évidentes argumentées
6. **Trous identifiés** — choses à creuser avant de scaler le périmètre

Ces handbooks sont la **source de vérité humaine** pour comprendre la
modélisation d'un provider. Le code (`packages/providers/<vendor>/src/`)
matérialise ce qui est ici. Le diff entre handbook et code est tracé via
le frontmatter `tracks:` (cf. skill `drift-detector`).

## Liste

| Provider   | Handbook                                | Plane(s)                             | Risks         |
| ---------- | --------------------------------------- | ------------------------------------ | ------------- |
| GitHub     | [`github.md`](./github.md)              | `repo`                               | 14 + fallback |
| Vercel     | [`vercel.md`](./vercel.md)              | `runtime`                            | 15 + fallback |
| Supabase   | [`supabase.md`](./supabase.md)          | `db`, `storage`, `auth`, `functions` | 23 + fallback |
| Railway    | [`railway-ssh.md`](./railway-ssh.md) §1 | `runtime`                            | 11 + fallback |
| SSH (bash) | [`railway-ssh.md`](./railway-ssh.md) §2 | `host`                               | 5 + fallback  |

> Railway et SSH cohabitent dans un seul handbook car les deux providers
> ont émergé du même round d'analyse (.vaubaan/research/). À splitter
> en deux fichiers si la doc grossit.

## Mise à jour

Quand un risk catalog YAML / TS change, mettre à jour le handbook
correspondant dans la même PR. Le frontmatter `tracks:` liste les
fichiers code à surveiller.

Pour drafter un nouveau provider, copier la structure d'un handbook
existant et reproduire les 6 sections.
