---
title: MCP-only en MVP — pas de CLI/SDK proxy
status: accepted
date: 2026-05-22
---

# MCP-only en MVP — pas de CLI/SDK proxy

## Contexte

Un coding agent moderne (Claude Code, Cursor, Continue) appelle des outils
de plusieurs manières :

- Via **MCP** (Model Context Protocol — JSON-RPC sur HTTP/SSE/stdio) :
  l'agent envoie `tools/call name=github__create_pr ...` à un serveur MCP.
- Via **CLI** directe : l'agent exécute `gh pr create ...` dans le terminal.
- Via **SDK / API HTTPS** : l'agent importe `@octokit/rest` et appelle
  `octokit.pulls.create(...)`.

Le MCP Proxy ne peut intercepter que le canal **MCP**. Les deux autres
canaux contournent le proxy.

## Décision

**MVP = MCP uniquement.** Le gateway `/mcp` intercepte exclusivement les
calls JSON-RPC. Si un agent exécute `gh pr create` ou importe Octokit
dans son code, **il bypass le proxy**.

Pour le MVP, on assume que les coding agents _modernes_ font la majorité
de leur travail via MCP (c'est la direction de l'industrie : Anthropic,
OpenAI, Cursor poussent MCP comme protocole unifié). Le scope MVP est
donc utile sans être exhaustif.

Hors-scope MVP :

- Aucun proxy CLI (interception via PATH override / wrapper scripts).
- Aucun proxy SDK (MITM TLS via CA root custom à installer sur le client).
- Aucun runtime sandbox (eBPF, AppArmor) sur le client agent.

v1.5+ pourra envisager un MITM TLS proxy avec custom CA pour couvrir CLI

- SDK. ADR séparé à drafter à ce moment-là.

## Conséquences

**Positives :**

- **Surface MVP minimale.** Un seul protocole à modéliser, une seule
  interception. Le gateway est un endpoint HTTP, pas un binaire CLI à
  distribuer.
- **Pas de friction d'install client.** L'agent configure son `mcp.json`
  avec `https://vaubaan.com/mcp` + Bearer token. Pas de CA root à installer,
  pas de shim CLI à mettre dans le PATH.
- **Compatible le-jour-1 avec Claude Code, Cursor, Continue, n'importe
  quel client MCP.**

**Négatives :**

- **Surface de bypass connue.** Si l'agent ouvre un terminal et tape
  `gh pr merge`, ça contourne le proxy. Mitigations partielles :
  - Documentation explicite ("Vaubaan filtre les MCP calls ; pour exiger
    le filtrage, configure ton agent pour utiliser MCP uniquement").
  - Token GitHub côté agent ? **Non** — l'agent n'a justement pas de PAT
    GitHub propre dans le modèle v4. Si l'agent veut utiliser `gh`, il
    doit s'authentifier via _son_ compte humain (ce que Claude Code fait
    par défaut) — pas via Vaubaan. Le proxy n'a juridiction que sur les
    calls qui _passent par lui_.
  - Audit côté provider (GitHub audit log) : on voit le bot Vaubaan _et_
    on voit les calls humains. Un humain qui delete un repo via `gh`
    apparaît côté GitHub.
- **Le marketing doit être honnête.** "Policy-enforcing gateway for MCP
  tool calls" — pas "kill switch for all agent actions". Si l'org veut
  vraiment ceinture+bretelles, c'est v1.5 (MITM) ou un sandbox agent
  séparé.

## Alternatives rejetées

- **Inclure le proxy CLI dès le MVP.** Rejeté : friction d'install client
  (PATH manipulation, alias bashrc), surface de contournement immense
  (`/usr/bin/git`, scripts shell custom, npm scripts), maintenance d'un
  wrapper par CLI provider. Coût ≫ valeur pour un MVP.
- **MITM TLS dès le MVP.** Rejeté : installer une CA root client est un
  red flag sécu majeur (impacte _tous_ les calls HTTPS du laptop, pas
  seulement les calls cibles), friction d'onboarding insurmontable, et
  on perd l'argument simplicité du proxy MCP.
- **Sandbox runtime client (eBPF / nsjail).** Rejeté : OS-specific, friction
  d'install, scope énorme. Hors charte produit MVP.
