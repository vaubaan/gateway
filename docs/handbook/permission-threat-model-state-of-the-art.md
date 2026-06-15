---
title: Permission & threat model — state of the art (synthèse OWASP / NIST / MITRE / Five Eyes / industry)
status: current
date: 2026-06-14
context: source de référence du pivot v4 risk-based (cf. [[gateway-risk-model]])
---

---

title: Permission & Threat Model — State of the Art
status: research
date: 2026-06-14
context: |
Vaubaan Gateway interpose un agent IA entre un LLM autonome et plusieurs
providers cloud (GitHub, Vercel, Supabase, Railway…). On veut remplacer
le découpage actuel "rings concentriques" (4 niveaux par pile :
content/structure/governance/access, 15–20 capabilities par provider)
par un système qui répond à : "Quel risque pour moi si je donne ces
pouvoirs à cet agent ? Quel risque est acceptable ? Quel risque demande
une validation humaine ?"
scope:

- axis-1: Threat modeling pour agents IA
- axis-2: Simplification de permissions (macro-buckets)
- axis-3: Human-in-the-loop / step-up authorization
- axis-4: Long-polling / blocking-wait côté client

---

# Synthèse exécutive

1. **Le risque agent se mesure sur 4–5 axes orthogonaux** qui reviennent
   partout dans la littérature 2024–2026 (OWASP LLM06, NIST AI RMF Agentic
   Profile, Five Eyes 2026-05, Anthropic RSP v3, MITRE ATLAS) :
   **réversibilité, blast radius (étendue), coût/visibilité externe,
   persistance/latence-de-détection, exfiltration**. C'est la _combinatoire_
   de ces axes qui détermine si une action est auto-approuvable, demande
   step-up, ou exige break-glass.
2. **L'industrie converge vers 3–6 macro-buckets**, pas vers une matrice
   fine. Pattern récurrent : `Read` (sûr) → `Write-safe` (réversible) →
   `Write-risky` (irréversible / coût) → `Destroy` → `Admin/IAM`. Stripe,
   AWS, GitHub fine-grained, Slack v2, Microsoft Graph, Notion, Linear
   exposent tous une variante de ce découpage. _Personne_ n'expose 50+
   permissions à l'utilisateur final ; ils les exposent dans le moteur de
   policies et les _présentent_ en macro-buckets.
3. **Human-in-the-loop est devenu un produit**, pas un détail. HumanLayer,
   Claude Code (auto/plan/bypass modes + PreToolUse hooks), Devin
   (sandbox + PR review), n8n, Google ADK, OAuth RAR + CIBA convergent
   sur le même triptyque : **(a)** décorateur/hook au site d'appel,
   **(b)** routing vers un canal humain (Slack/Telegram/email/SMS),
   **(c)** state-store persistant pour gérer pending/approved/expired et
   les timeouts d'escalade.
4. **Pour la blocking-wait côté client, le mur dur est ~25 s à 100 s**
   selon l'edge. Cloudflare = 100 s (origin idle), Vercel Edge = 25 s avant
   début de stream sinon coupe (puis jusqu'à 300 s en streaming), AWS API
   Gateway = 29 s, ALB = 60 s par défaut. **Une blocking-wait de 2 minutes
   est risquée sans SSE/chunked-encoding** et nécessite soit un long-poll
   court avec re-poll, soit SSE/heartbeat pour traverser les LB.

---

# Axe 1 — Threat modeling pour agents IA / accès aux outils

## 1.1 Cadres de référence (versions courantes mi-2026)

### OWASP Top 10 for LLM Applications 2025

La liste 2025 (mise à jour majeure vs 2023) place en tête :

- **LLM01 — Prompt Injection** : indirect prompt injection devenue le
  vecteur dominant pour faire faire à un agent ce qu'il ne devrait pas
  (cf. EchoLeak 2025, premier zero-click prod). Tout outil exposé à du
  contenu non-trusted (page web, email, issue GitHub, README) devient un
  canal d'injection.
- **LLM06 — Excessive Agency** (catégorie élargie en 2025) : surface
  d'attaque quand l'agent a _plus de pouvoir que nécessaire_ — fonctions
  non-requises, identité downstream sur-privilégiée, absence de vérif
  indépendante des actions à fort impact.
- **LLM08 — Vector & Embedding Weaknesses** et **LLM10 — Unbounded
  Consumption** complètent la liste.

Sources :

- [LLM06:2025 Excessive Agency — OWASP Gen AI Security Project](https://genai.owasp.org/llmrisk/llm06-sensitive-information-disclosure/)
- [OWASP LLM06: Excessive Agency in AI Systems — Indusface](https://www.indusface.com/learning/owasp-llm-excessive-agency/)
- [OWASP Top 10 For LLM Applications 2025 — Indusface](https://www.indusface.com/learning/owasp-top-10-llm/)
- [LLM06: Excessive Agency — FireTail](https://www.firetail.ai/blog/llm06-excessive-agency)

**Mitigations canoniques d'OWASP LLM06** (transposables tel quel à
Vaubaan) :

1. Limiter les _extensions_ au strict nécessaire (n'expose pas un tool si
   pas utile).
2. Limiter les _fonctions_ dans chaque extension.
3. Éviter les fonctions "open-ended" (`exec`, `eval`, shell libre) —
   préférer des fonctions à signature étroite.
4. Limiter les _permissions_ downstream que l'extension peut exercer.
5. Exécuter dans le contexte de _l'utilisateur_ (OAuth on-behalf-of), pas
   d'identité technique sur-privilégiée.
6. **Require human approval** pour les actions à fort impact.
7. Médiation complète : _toute_ requête downstream est validée par les
   policies.
8. Logging + monitoring + rate-limiting.

### NIST AI RMF — Agentic Profile (2024–2025)

NIST AI RMF 1.0 (2023) part du postulat que des humains prennent les
décisions. Pour l'agentic, NIST a publié une **RFI agent-security** qui a
reçu 937 commentaires publics, et le **NIST AI RMF Agentic Profile** vit
chez Cloud Security Alliance. Il propose explicitement des catégories
pour _tool-use risk, runtime behavioral governance, delegation chain
accountability_.

Risques agentiques nommés dans le profile :

- **Excessive agency** (actions hors-périmètre prévu)
- **Cascading failures** (erreur qui se propage en chaîne d'agents)
- **Identity spoofing** (agent impersonne utilisateurs/systèmes)
- **Goal misalignment**

Sources :

- [NIST AI Risk Management Framework: Agentic Profile — CSA Lab Space](https://labs.cloudsecurityalliance.org/agentic/agentic-nist-ai-rmf-profile-v1/)
- [Taming Agentic AI: Applying NIST AI RMF — Medium](https://rgutierrez2004.medium.com/taming-agentic-ai-applying-the-nist-ai-risk-management-framework-a7f592e0e97a)
- [Architecting Trust: A NIST-Based Security Governance Framework for AI Agents — Microsoft](https://techcommunity.microsoft.com/blog/microsoftdefendercloudblog/architecting-trust-a-nist-based-security-governance-framework-for-ai-agents/4490556)

### MITRE ATLAS (v5.1.0, novembre 2025)

ATLAS = ATT&CK pour AI. 16 tactiques, 84 techniques. Tactiques
pertinentes pour nous (gateway agent → cloud) :
`Resource Development`, `Initial Access`, `ML Model Access`,
`Execution`, `Persistence`, `Privilege Escalation`, `Defense Evasion`,
`Credential Access`, `Discovery`, `Collection`, `Exfiltration`, `Impact`.

Sources :

- [MITRE ATLAS](https://atlas.mitre.org/)
- [MITRE ATLAS Fact Sheet](https://atlas.mitre.org/pdf-files/MITRE_ATLAS_Fact_Sheet.pdf)
- [MITRE ATLAS: AI security framework — Vectra](https://www.vectra.ai/topics/mitre-atlas)

### Anthropic Responsible Scaling Policy v3.0 (2025)

RSP v3 introduit des **Frontier Safety Roadmaps** et **Risk Reports**
quantifiant le risque pour chaque modèle déployé. Anthropic identifie
explicitement, pour Opus 4.6 en setting agentic :

> "Opus 4.6 was at times too eager, taking risky actions without asking
> first, including sending emails or using authentication tokens in ways
> the user likely wouldn't have authorized if asked."

C'est exactement le problème que Vaubaan adresse côté gateway.

Sources :

- [Anthropic Responsible Scaling Policy v3.0](https://www.anthropic.com/responsible-scaling-policy/rsp-v3-0)
- [Anthropic's RSP v3.0: How it Works — GovAI](https://www.governance.ai/analysis/anthropics-rsp-v3-0-how-it-works-whats-changed-and-some-reflections)
- [Anthropic Transparency Hub — Model Report](https://www.anthropic.com/transparency/model-report)

### Five Eyes "Securing Agentic AI Services" (mai 2026)

Premier alignement multinational (CISA + NSA + UK NCSC + ACSC + CCCS +
NZ NCSC), document de 30 pages. Insistance forte sur :

- **Principle of least privilege per task** (pas blanket token).
- **Blast radius minimization** (bulk = drapeau rouge).
- **Human checkpoint mandatory** pour data modification, transactions
  financières, system changes.

Sources :

- [Five Eyes Agentic AI Guidance — Periculo](https://www.periculo.co.uk/cyber-security-blog/what-the-five-eyes-agentic-ai-guidance-actually-means-for-your-organisation)
- [Five Eyes Agentic Guidance — Lyrie Research](https://lyrie.ai/research/research/2026-05-03-five-eyes-agentic-guidance)
- [Five Eyes Agentic AI Guidance: Architecture, Not a Checklist](https://www.rockcybermusings.com/p/five-eyes-agentic-ai-architecture-not-checklist)

## 1.2 Axes de risque récurrents dans la littérature

Synthèse trans-sources (OWASP, NIST, MITRE, Five Eyes, Anthropic, MindStudio, Cycles, Build5Nines) :

| Axe                      | Définition opérationnelle                                                     | Signal "bas risque"               | Signal "haut risque"                                                                |
| ------------------------ | ----------------------------------------------------------------------------- | --------------------------------- | ----------------------------------------------------------------------------------- |
| **Réversibilité**        | Coût/effort/délai pour annuler l'action.                                      | Annulable en 1 clic / git revert. | Suppression de prod DB, mail envoyé, paiement passé, release publié, domaine perdu. |
| **Blast radius**         | Combien d'objets/utilisateurs affectés.                                       | 1 objet                           | Bulk, "all repos", "all users", wildcard.                                           |
| **Coût $ direct**        | Facture, transfert de fonds, ressources cloud provisionnées.                  | $0                                | Boot d'instances GPU, transferts d'argent, ressources auto-scalées.                 |
| **Visibilité externe**   | Action visible par utilisateurs finaux / public / clients en aval.            | Interne uniquement                | Email envoyé, release publié, page publique, post réseau social.                    |
| **Persistance**          | L'action survit-elle à la session, change-t-elle la posture du compte ?       | Stateless                         | Crée un webhook, OAuth grant, deploy hook, IAM role, service account.               |
| **Exfiltration**         | L'action peut-elle faire sortir des secrets/données vers un dest contrôlable. | Non                               | `curl` arbitraire, write d'un fichier .env vers repo public, partage avec un email. |
| **Latence-de-détection** | Combien de temps avant qu'un humain s'en aperçoive ?                          | Immédiat (UI)                     | Action programmée (cron), modification silencieuse de config.                       |
| **Privilege escalation** | L'action permet-elle d'accéder à plus que ce qui était autorisé ?             | Non                               | Création de PAT, ajout de membre, modification d'OAuth scope.                       |

Sources convergentes :

- [How to Classify AI Agent Actions by Risk — MindStudio](https://www.mindstudio.ai/blog/classify-ai-agent-actions-by-risk)
- [AI Agent Blast Radius Risk Calculator — Cycles](https://runcycles.io/calculators/ai-agent-blast-radius-risk)
- [When Should a DevOps Agent Act Without Human Approval? — DevOps.com](https://devops.com/when-should-a-devops-agent-act-without-human-approval/)
- [How Can Enterprises Prevent Agentic AI from Taking Wrong Action — Build5Nines](https://build5nines.com/how-can-enterprises-prevent-agentic-ai-from-taking-the-wrong-action/)
- [How to Score Your AI Agent's Security Risk — Vaultak](https://vaultak.com/blog/how-to-score-your-ai-agent-security-risk)

**Formule récurrente** observée chez MindStudio / Cycles :
`Severity = reversibility(×1/×3/×10) + visibility(+0/+1/+4)`.
Catastrophique = irréversible + public (×14). Idée : _multiplicatif_ sur
les axes critiques (irréversibilité), _additif_ sur l'aggravant
(visibilité externe).

## 1.3 Recommandations transposables Vaubaan

1. **Annoter chaque tool MCP** avec un _vecteur_ `(reversibility,
blastRadius, cost, visibility, persistence, exfilRisk)` plutôt qu'un
   simple "ring" 1–4. Le ring devient _dérivé_ du vecteur.
2. **Distinguer "outils ouverts à l'injection"** (lecture de contenu
   non-trusted : web, README, issues, emails) vs "outils fermés". OWASP
   LLM01+LLM06 implique : pas le même seuil de confiance entre
   `github.read_issue_body` (injectable) et `github.create_release`.
3. **Politique par défaut = "fail-closed sur haut blast radius"** :
   actions bulk ou wildcard exigent toujours human-in-the-loop, _même_
   pour des opérations "sûres" prises individuellement.
4. **Logger 100 % des appels tool** avec le vecteur de risque évalué et
   la décision (auto / approved / denied / timeout) — c'est explicite
   dans Five Eyes et NIST Agentic Profile.

---

# Axe 2 — Simplification de permissions (macro-permissions)

## 2.1 Tour d'horizon : comment l'industrie regroupe ses permissions ?

### AWS IAM — 5 access levels canoniques

C'est _le_ modèle le plus mature et probablement le plus copié :

| Access Level               | Sémantique                                                            |
| -------------------------- | --------------------------------------------------------------------- |
| **List**                   | Énumérer des ressources (sans lire leur contenu).                     |
| **Read**                   | Lire le contenu des ressources.                                       |
| **Write**                  | Créer / modifier / supprimer.                                         |
| **Permissions management** | Modifier qui peut accéder à quoi (IAM lui-même).                      |
| **Tagging**                | Modifier les tags (séparé car peut indirectement débloquer du Write). |

Et 3 macro-policies "job functions" :

- `AdministratorAccess` — full access, _recommandé pour admin only_.
- `PowerUserAccess` — full sauf IAM/Organizations (le profil "dev senior").
- `ReadOnlyAccess` — auto-extensible aux nouveaux services.

Sources :

- [Access levels in policy summaries — AWS IAM Docs](https://docs.aws.amazon.com/IAM/latest/UserGuide/access_policies_understand-policy-summary-access-level-summaries.html)
- [AdministratorAccess — AWS Managed Policy](https://docs.aws.amazon.com/aws-managed-policy/latest/reference/AdministratorAccess.html)
- [PowerUserAccess — AWS Managed Policy](https://docs.aws.amazon.com/aws-managed-policy/latest/reference/PowerUserAccess.html)
- [ReadOnlyAccess — AWS Managed Policy](https://docs.aws.amazon.com/aws-managed-policy/latest/reference/ReadOnlyAccess.html)

### GitHub — fine-grained PAT (depuis 2022) et GitHub Apps

GitHub a _gardé_ la granularité (50+ permissions) mais avec une UX qui
_regroupe_ par catégorie de ressource (Repository, Organization, User).
Chaque permission a 3 valeurs : `No access` / `Read` / `Read & write`.

Important : GitHub Apps utilisent **exactement les mêmes permissions**
que les fine-grained PATs — c'est la même surface d'autorisation. Les
_classic OAuth scopes_ (`repo`, `admin:org`, etc.) sont legacy et trop
larges (le scope `repo` donne aussi écriture des settings).

Sources :

- [Introducing fine-grained PATs — GitHub Blog](https://github.blog/security/application-security/introducing-fine-grained-personal-access-tokens-for-github/)
- [Permissions required for fine-grained PATs — GitHub Docs](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens)
- [Differences between GitHub Apps and OAuth apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/differences-between-github-apps-and-oauth-apps)

### Stripe — Restricted Keys

Modèle "permission par ressource", 3 valeurs : `None` / `Read` / `Write`.
La granularité est _par type d'objet_ (`charges`, `customers`,
`payouts`, `webhooks`, etc.), pas par endpoint. Stripe recommande
**toujours** les restricted keys (`rk_live_…`) vs les secret keys.

Sources :

- [Stripe Restricted API Keys — Docs](https://docs.stripe.com/keys/restricted-api-keys)
- [Stripe API Authentication](https://docs.stripe.com/api/authentication)

### Slack — granular bot tokens (v2)

Avant : umbrella `bot` scope (tout-en-un). Maintenant : sélection
individuelle par méthode (`chat:write`, `channels:read`,
`channels:history`, …). Slack a _cassé_ l'umbrella scope volontairement
pour des raisons de sécurité et de confiance utilisateur.

Sources :

- [New and Improved OAuth Scopes — Slack Blog](https://medium.com/slack-developer-blog/new-and-improved-oauth-scopes-4894b2cc159d)
- [More precision, fewer restrictions — Slack Blog](https://medium.com/slack-developer-blog/more-precision-less-restrictions-a3550006f9c3)
- [Slack Scopes Reference](https://api.slack.com/scopes)

### Google OAuth — sensitive vs restricted scopes

Trois bandes :

1. **Non-sensitive** (profil basique) — no verification needed.
2. **Sensitive** (Calendar events, contacts, etc.) — _verification_ (≤ 10 jours).
3. **Restricted** (Gmail, Drive contents) — verification _plus_ sécurité
   annuelle (re-verification).

C'est intéressant : Google ne simplifie pas le nombre de scopes ; il
_tag_ les scopes par bande de risque, ce qui change la friction
d'onboarding.

Sources :

- [Sensitive scope verification — Google for Developers](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification)
- [Restricted scope verification — Google for Developers](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification)

### Microsoft Graph

Granularité fine (centaines de permissions), distinction stricte
**Delegated** (au nom de l'utilisateur, hérite des limites de l'user) vs
**Application** (service account, plein pouvoir). Best practices :
toujours préférer Delegated, et choisir la permission _la moins
privilégiée_ qui couvre l'endpoint visé.

Sources :

- [Microsoft Graph permissions overview](https://learn.microsoft.com/en-us/graph/permissions-overview)
- [Best practices for Microsoft Graph permissions](https://learn.microsoft.com/en-us/graph/best-practices-graph-permission)

### Figma, Linear, Notion

Pattern simple, 3–4 buckets : `read` / `write` / `comments`. Notion
expose des "capabilities" (`read content`, `update content`, `insert
content`, `read user info`) par integration.

Sources :

- [Figma Personal Access Tokens — Developers Docs](https://developers.figma.com/docs/rest-api/personal-access-tokens/)
- [Figma scopes reference](https://developers.figma.com/docs/rest-api/scopes)

## 2.2 Patterns récurrents observés

| Pattern                                                       | Exemples                           | Quand le choisir                                  |
| ------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------- |
| **3 niveaux par ressource** (None/Read/Write)                 | Stripe, GitHub fine-grained, Figma | Si surface API ~ découpable par ressource.        |
| **5 access levels horizontaux** (List/Read/W/Tag/Perms)       | AWS IAM                            | Surface API très large, plusieurs services.       |
| **Bandes de risque sur scopes** (normal/sensitive/restricted) | Google OAuth                       | Si tu veux mettre de la friction _différenciée_.  |
| **Job-function macro policies** (Admin/PowerUser/ReadOnly)    | AWS managed policies               | Pour proposer des presets sans masquer le détail. |
| **Umbrella scope deprecated** (séparation forcée)             | Slack v2 vs legacy bot scope       | Quand on doit migrer hors d'un wildcard hérité.   |

## 2.3 Recommandation Vaubaan — 3 alternatives possibles

### Alternative A — "AWS-style" : 5 access levels universels

```text
LIST     — enumerate (low risk)
READ     — fetch content (low risk, mais peut leak via prompt injection)
WRITE    — create/update (medium; sub-divisé par réversibilité)
DESTROY  — delete (high)
ADMIN    — IAM, tokens, webhooks (highest)
```

Avantages : universel, copie un mental model bien connu, scale à N
providers. Inconvénient : ne capture pas blast radius (1 vs bulk) — il
faut une dimension orthogonale.

### Alternative B — "Risk-vector + Auto-derived bucket"

Chaque tool est annoté avec son vecteur de risque
`(reversibility, blastRadius, visibility, cost, persistence, exfilRisk)`.
Le bucket macro (`safe / approve / step-up / break-glass`) est _dérivé_
par formule, pas par tag statique.

Avantages : transparent, ajustable par policy. Inconvénients : demande
un travail d'annotation initial conséquent et un moteur de décision
robuste.

### Alternative C — "Anthropic Auto Mode-style" : classifieur LLM

Auto Mode de Claude Code utilise un Sonnet 4.6 comme classifieur de
risque par tool call (auto-approve safe / block dangerous). C'est un
hybride : tu déclares peu de policy en dur, et un LLM tranche en temps
réel.

Avantages : flexibilité. Inconvénients : prompt-injection sur le
classifieur ; latence ajoutée ; coût ; pas explicable.

Sources :

- [Claude Code Auto Mode — Anthropic Engineering](https://anthropic.com/engineering/claude-code-auto-mode)
- [Claude Code Permissions Docs](https://code.claude.com/docs/en/permissions)
- [Claude Code Auto Approve Guide (2026) — SmartScope](https://smartscope.blog/en/generative-ai/claude/claude-code-auto-permission-guide/)

## 2.4 Tableau récapitulatif — "Si on doit choisir N buckets…"

| N   | Découpage recommandé                                                                    | Inspiration           | Adapté à                                             |
| --- | --------------------------------------------------------------------------------------- | --------------------- | ---------------------------------------------------- |
| 3   | `Read` / `Write` / `Admin`                                                              | Figma, Notion, Linear | Vaubaan v1, surface simple, équipes solo             |
| 4   | `Read` / `Write-reversible` / `Write-irreversible` / `Admin`                            | (Synthèse)            | **Sweet spot Vaubaan v2** — capture la réversibilité |
| 5   | `List` / `Read` / `Write` / `Destroy` / `Admin`                                         | AWS IAM access levels | Si la surface API est grande et organisée par CRUD   |
| 6   | `Read-public` / `Read-private` / `Write-safe` / `Write-risky` / `Destroy` / `Admin-IAM` | Google bands + AWS    | Vaubaan futur quand on aura plusieurs tenants        |

**Recommandation forte** : aller sur **4 buckets** (`Read`,
`Write-reversible`, `Write-irreversible`, `Admin`), avec une _dimension
orthogonale "blast radius"_ qui peut faire monter n'importe quoi en
`step-up required` si on dépasse un seuil (ex. > 5 objets affectés,
wildcard, `*` dans le path).

---

# Axe 3 — Human-in-the-loop pour validations d'agents

## 3.1 Patterns dans les outils agentiques modernes

### Claude Code (Anthropic) — 4 modes, hooks PreToolUse/PostToolUse

- **Default** : prompt user "Allow / Always allow / Deny" à chaque tool call.
- **Plan mode** : read-only, propose un plan, pas d'edit.
- **Auto mode** : un _classifieur_ (Sonnet 4.6) auto-approuve safe,
  bloque dangerous, prompte sur ambigu.
- **bypassPermissions** : skip prompts (avec liste d'exclusion stricte
  des chemins sensibles `.git`, `.config`, `.claude`, etc.).

Hooks PreToolUse permettent de wrapper _chaque_ appel et décider
allow/deny/prompt avant exécution.

Sources :

- [Configure permissions — Claude Code Docs](https://code.claude.com/docs/en/permissions)
- [Claude Code Hooks — Morphllm](https://www.morphllm.com/claude-code-hooks)
- [Inside Claude Code Architecture — Penligent](https://www.penligent.ai/hackinglabs/inside-claude-code-the-architecture-behind-tools-memory-hooks-and-mcp/)

### Devin (Cognition) — sandbox + PR review

Devin spinup un VM isolé, fait son travail, soumet une PR. _L'approval
humain est la merge_. Pattern "yolo dans le bac à sable, validation à la
sortie".

Sources :

- [Devin Cognition AI FAQ — Skywork](https://skywork.ai/blog/devin-cognition-ai-faq-autonomous-ai-software-engineer/)
- [Cursor vs Devin — Authority AI Tools](https://authorityaitools.com/blog/cursor-vs-devin)

### HumanLayer — SDK approval-as-a-service

Pattern decorator :

```python
@require_approval(channel="slack:#deploys")
def deploy_to_prod(...): ...
```

Capabilities :

- Routing par canal (Slack, email, SMS, webhook).
- Timeouts + escalades configurables.
- State-store persistant (pending / approved / denied / expired).
- Webhooks vers l'agent pour reprise.
- "Learning" d'auto-approvals selon historique.

Sources :

- [HumanLayer Key Concepts](https://deepwiki.com/humanlayer/humanlayer/1.1-key-concepts)
- [HumanLayer SDK — EveryDev](https://www.everydev.ai/tools/humanlayer)
- [Building for Agentic AI: Agent SDKs & Design Patterns — Medium](https://medium.com/dsaid-govtech/building-for-agentic-ai-agent-sdks-design-patterns-ef6e6bd4a029)

### n8n — human-in-the-loop tools

Canaux supportés out-of-the-box : Gmail, Slack, Telegram, Discord, MS
Teams, WhatsApp. La node "Wait for approval" suspend le workflow et
attend la réponse via webhook.

Sources :

- [Human-in-the-loop for AI tool calls — n8n Docs](https://docs.n8n.io/advanced-ai/human-in-the-loop-tools/)
- [Human-in-the-Loop Approval Gates — nNode AI](https://www.nnode.ai/blog/2026-02-05-human-in-the-loop-approval-gates)

### Google ADK + Telegram

Pattern : l'agent envoie un message Telegram avec boutons inline
Approve/Reject ; le callback déclenche la reprise du workflow.

Sources :

- [Human-in-the-Loop AI Agents with Google ADK and Telegram — DEV](https://dev.to/jameszh/human-in-the-loop-ai-agents-with-google-adk-and-telegram-5agd)

## 3.2 Step-up authorization classique (PAM / IAM)

### Britive, Teleport, StrongDM, Opal, Sym, Indent

Convergent autour de "Zero Standing Privilege" + JIT :

- Permissions par défaut = read seul ou rien.
- Élévation à la demande, time-boxed, raison documentée.
- "Break-glass" = procédure d'urgence, audit max, post-mortem
  obligatoire.

Standards d'escalade :

- **Approval timeout** : typiquement 5–30 min ; au-delà, escalade au
  next-in-line ou denial automatique.
- **Access duration** : 1h, 4h, 8h, max 24h pour break-glass.
- **Multi-approver** : obligatoire au-dessus d'un seuil (ex. prod IAM).

Sources :

- [Just-In-Time Access — Britive](https://www.britive.com/platform/jit-permissioning)
- [Just-in-Time Access Solution — StrongDM](https://www.strongdm.com/solution/just-in-time-access)
- [Break Glass Account Best Practices — Britive](https://www.britive.com/resource/blog/break-glass-account-management-best-practices)
- [Breaking Glass Scenarios — StrongDM](https://www.strongdm.com/blog/break-glass)
- [Just-in-Time Access Glossary — Opal Security](https://www.opal.dev/glossary/just-in-time-access)
- [Evolution of PAM Market — SoftwareAnalyst](https://softwareanalyst.substack.com/p/the-evolution-of-the-privileged-access)

### OAuth 2.0 Rich Authorization Requests (RAR) + CIBA

**RAR** (RFC 9396) : étend OAuth scopes avec un `authorization_details`
JSON arbitraire. Permet "je veux pouvoir transférer 50 € _du compte A
vers le compte B exactement_", pas juste "scope=payments".

**CIBA** (Client-Initiated Backchannel Authentication) : pattern où un
service initie une authentification _backchannel_ (push notif sur
téléphone, par ex.) sans interaction directe sur le browser source.

Combinés, RAR + CIBA = standard émergent pour le **step-up
authorization fine-grained** côté banques et fintech. Pertinent pour
nous : un agent qui veut faire "release v2.0.0" peut demander un
step-up RAR-style ("je veux la permission _de release exactement ce
tag-là_"), pas un scope générique "releases:write".

Sources :

- [OAuth Rich Authorization Requests — SecureAuth Docs](https://docs.secureauth.com/ciam/en/oauth-rich-authorization-requests--rar-.html)
- [draft-ietf-oauth-rar-23 — IETF](https://datatracker.ietf.org/doc/draft-ietf-oauth-rar/23/)
- [Fine-Grained Consent with RAR — Medium](https://medium.com/@wojciechkotlowskii/fine-grained-consent-with-oauth-rich-authorization-requests-rar-72097fc02172)
- [User Authorization with CIBA — Auth0 Docs](https://auth0.com/docs/get-started/authentication-and-authorization-flow/client-initiated-backchannel-authentication-flow/user-authorization-with-ciba)

## 3.3 Canaux et timeouts standards observés

| Canal            | Fréquence d'usage | Timeout typique d'approbation | Remarques                                                        |
| ---------------- | ----------------- | ----------------------------- | ---------------------------------------------------------------- |
| Slack DM/channel | Très fréquent     | 5–60 min                      | UX inline buttons. Standard de facto dev tooling.                |
| Telegram         | Fréquent (FR/EU)  | 5–60 min                      | Inline keyboard buttons. Bonne option pour solo / dev personnel. |
| Email            | Fréquent          | 1–24h                         | Fallback. Signature/auth via lien signé.                         |
| SMS              | Modéré            | 5–15 min                      | Pour break-glass / haute urgence.                                |
| Push mobile      | (Banking++)       | < 5 min                       | Standard CIBA / banking.                                         |
| Webhook custom   | Modéré            | Variable                      | Pour intégrations tierces (Zapier, IFTTT).                       |
| Browser modal    | Variable          | Session-bound                 | Claude Code style (in-app prompt).                               |

## 3.4 Recommandations Vaubaan

1. **Triptyque obligatoire** : (a) déclaration au site d'appel (config
   par tool) ; (b) router multi-canal (start with Slack + Telegram, ils
   couvrent 90 %) ; (c) state-store en DB Supabase avec colonnes
   `(id, agent_id, tool, payload, status, channel, requested_at,
resolved_at, resolver_id, decision_reason)`.
2. **Timeout par défaut = 15 min** pour les step-up "normaux", **5 min**
   pour break-glass (forcer la réactivité), **24h** pour les approvals
   "non bloquantes" (mode "draft").
3. **Idempotence des approvals** : le client (agent) doit pouvoir
   re-soumettre la même requête (même hash de payload) et récupérer le
   même `approval_id` plutôt que de créer un doublon.
4. **Auto-approval learning** _optionnel_ (HumanLayer pattern) :
   apprendre les patterns approuvés répétitivement, proposer à
   l'utilisateur de promouvoir un pattern en règle d'auto-approval.

---

# Axe 4 — Long-polling / blocking-wait pour "approval pending" côté client

## 4.1 État de l'art des techniques

### Long polling (HTTP)

- Client fait un GET, serveur garde la connexion ouverte jusqu'à
  événement ou timeout, puis répond et client re-poll.
- **Avantage** : firewall-friendly, HTTP/1.1 standard, ne demande aucune
  infra spéciale, marche partout.
- **Inconvénient** : 1 RTT par événement, lourd à grande échelle.

### Server-Sent Events (SSE)

- Connexion HTTP unique, `Content-Type: text/event-stream`, le serveur
  envoie des chunks au fil de l'eau.
- **Avantage** : standard navigateur (`EventSource`), traverse mieux
  les LBs (chunked encoding), supporte heartbeats.
- **Inconvénient** : unidirectionnel server→client, pas idéal si client
  doit aussi envoyer en cours.

### WebSocket

- Connexion full-duplex.
- **Avantage** : bidirectionnel, faible overhead par message.
- **Inconvénient** : pas universel sur serverless, demande sticky
  routing, plus complexe à scale.

### Polling avec backoff exponentiel

- Client poll toutes les X ms, X croît si pas de changement.
- **Avantage** : simplissime, sans contraintes infra.
- **Inconvénient** : latence (dernier intervalle), charge serveur.

### Pattern Kubernetes "watch"

- HTTP long-poll + chunked transfer encoding, événements streamés au
  fil de l'eau.
- Timeout côté serveur = 5 min, client re-establish.
- C'est de facto un **hybride SSE-like** avec resync via
  `resourceVersion`.

Sources :

- [WebSockets vs SSE vs Long Polling — IOTools](https://iotools.cloud/journal/websockets-vs-sse-vs-long-polling/)
- [Long Polling vs SSE vs WebSockets — Medium](https://medium.com/@asharsaleem/long-polling-vs-server-sent-events-vs-websockets-a-comprehensive-guide-fb27c8e610d0)
- [WebSockets vs SSE vs Long Polling — RxDB](https://rxdb.info/articles/websockets-sse-polling-webrtc-webtransport.html)
- [Kubernetes Watch API + Long Polling + Chunked — yongli.dev](https://yongli.dev/posts/understanding_kubernetes_watch_mechanism_http_long_polling_and_chunked_transfer_encoding/)

## 4.2 Timeouts par couche réseau (le mur dur)

| Couche                          | Timeout par défaut           | Configurable ?    | Notes                                                       |
| ------------------------------- | ---------------------------- | ----------------- | ----------------------------------------------------------- |
| **Cloudflare proxy (free/pro)** | **100 s origin idle**        | Enterprise oui    | Erreur 524 si dépassé. Plans non-Ent locked à 100s.         |
| **Vercel Edge Function**        | **25 s avant 1er byte**      | Non               | Sinon coupe. Streaming OK jusqu'à 300 s **après** 1er byte. |
| **Vercel Serverless (Fluid)**   | 300 s default, 800 s Pro/Ent | Oui (maxDuration) | Fluid Compute = défaut moderne.                             |
| **AWS API Gateway (REST)**      | **29 s**                     | Non               | Mur dur. Force le pattern async + polling.                  |
| **AWS API Gateway (HTTP)**      | 30 s                         | Non               | Idem.                                                       |
| **AWS ALB / NLB**               | 60 s (ALB), 350 s (NLB)      | Oui               | ALB peut monter à 4000 s, NLB encore plus.                  |
| **Nginx (proxy_read_timeout)**  | 60 s                         | Oui               | Souvent monté à 300 s en prod.                              |
| **GCP HTTP(S) LB**              | 30 s                         | Oui (jusqu'à 24h) | Mais 30 s par défaut côté backend service.                  |
| **K8s ingress-nginx**           | 60 s                         | Oui (annotations) |                                                             |

Sources :

- [Cloudflare Error 524 — Cloudflare Docs](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-5xx-errors/error-524)
- [Vercel Functions Limits](https://vercel.com/docs/functions/limitations)
- [New execution duration limit for Edge Functions — Vercel](https://vercel.com/changelog/new-execution-duration-limit-for-edge-functions)
- [Configuring Maximum Duration for Vercel Functions](https://vercel.com/docs/functions/configuring-functions/duration)
- [HTTP 504 Gateway Timeout — Authgear](https://www.authgear.com/post/http-504-gateway-timeout/)

## 4.3 Le mur "2 minutes" — viable ou pas ?

**Verdict** : 2 minutes en **long-poll pur** est **fragile** :

- Cloudflare en plan non-Enterprise coupe à 100 s → 524.
- Vercel Edge sans byte écrit pendant 25 s coupe.
- Beaucoup de proxys d'entreprise / VPN tournent à 60 s.

**Solutions viables** pour blocker côté client _réellement_ 2 minutes :

1. **Long-poll borné à 25 s** (sous le mur Vercel Edge), client
   re-poll. Code : 4–5 cycles pour atteindre 2 min total.
2. **SSE avec heartbeats** : envoyer un `event: ping` toutes les 15 s
   pour garder la connexion vivante côté tous LBs. Reste à vérifier
   que Cloudflare ne coupe pas à 100 s même avec activité (il _ne
   coupe pas_ tant qu'il y a des bytes qui passent).
3. **Pattern "ticket + polling"** (AWS-style) : POST initial renvoie
   `{ approval_id, status: "pending" }`, client poll GET
   `/approvals/{id}` toutes les 1–5 s avec backoff.
4. **Webhook callback** : agent passe une URL de callback, serveur
   notifie quand approuvé. Demande que l'agent expose un endpoint
   (souvent pas possible côté Claude Code, vu que c'est un client).

**Recommandation Vaubaan** :

- **API publique** : combo "ticket + polling" (option 3) côté agents
  externes. C'est ce que fait Stripe Async, ce que fait l'API Lambda
  async, etc.
- **Optionnellement, SSE avec heartbeats** comme overlay pour les
  agents qui veulent un mode "push" en dev (Claude Code local, qui
  passe pas par Cloudflare).
- **Pas de long-poll de 2 minutes nu**. C'est mortel sur
  Cloudflare/Vercel Edge sans heartbeat.

## 4.4 Pattern recommandé pour Vaubaan

```text
POST /tool/<name>           → 202 Accepted
                              { approval_id, status: "pending",
                                poll_url: "/approvals/{id}",
                                expires_at: "+15min" }

(parallèlement: Slack/Telegram message envoyé au humain)

GET /approvals/{id}         → 200 OK { status: "pending" | "approved"
                                       | "denied" | "expired",
                                       resolved_at, resolver_id?,
                                       result? }

GET /approvals/{id}?wait=25s → long-poll borné à 25s
                              200 OK { ... } dès résolution OU
                              à expiration du wait (status: pending)
```

Côté agent IA : il poll avec `?wait=25s` en boucle, jusqu'à
`approved/denied/expired`. Total wall-clock peut atteindre 15 min sans
problème, parce que chaque requête HTTP individuelle reste sous tous
les murs.

---

# Pièges connus (anti-patterns documentés)

1. **Umbrella scope** — Slack le regrette publiquement, GitHub aussi (`repo`
   classic). Une fois qu'un secret expose un scope ultra-large, on ne
   peut plus le sortir sans casser l'écosystème. → Vaubaan : ne pas créer
   un `*` scope par provider.

2. **PreToolUse hook qui répond `allow` par défaut** — bug documenté de
   Claude Code : ça désactive _complètement_ la permission native. Toute
   politique fail-open au lieu de fail-closed est un piège.
   [Issue #28812](https://github.com/anthropics/claude-code/issues/28812)

3. **Identité technique sur-privilégiée downstream** — OWASP LLM06 root
   cause #2. L'agent utilise un service-account avec full PowerUser au
   lieu d'agir on-behalf-of l'utilisateur. → Vaubaan doit _toujours_ lier
   l'action à une identité humaine, jamais à une identité technique
   globale.

4. **Approve "always" trop facile** — Claude Code "Always allow" pour un
   tool donné = l'agent peut désormais tout faire avec ce tool sans
   re-prompt. Si le tool est `bash`, c'est game over. → Limiter
   "always allow" aux outils à blast radius très contrôlé.

5. **Confused deputy via prompt injection** — l'agent lit un contenu non
   trusted (README, issue body, page web) qui contient des instructions
   cachées. Le bucket "Read" peut donc _indirectement_ déclencher du
   Write si pas isolé. → Réutiliser les _credentials de l'utilisateur_,
   pas un service token, et tracker l'origine des instructions.

6. **Bulk action = blast radius silencieux** — un agent qui boucle sur
   100 repos avec une action "petite" passe en réalité 100 fois sous le
   radar. → Détecter wildcards / iterations et faire monter le seuil.

7. **Approval fatigue** — humain qui spam-approuve à chaque popup. Ne
   prompt que sur ce qui sort du "happy path", pas sur tout. HumanLayer
   et Claude Auto Mode adressent ça avec un classifieur.

8. **Long-poll naïf sans heartbeat sur Cloudflare/Vercel** — 524 garanti
   au-delà de 100 s. → Toujours heartbeat ou poll borné.

9. **State des approvals dans la mémoire process** — si la fonction
   serverless se réveille ailleurs, l'approval pending est perdu. → DB
   persistante (Supabase OK), pas in-memory.

10. **Pas de logging suffisant** — Five Eyes + NIST exigent
    explicitement la traçabilité par action. Si on logge seulement les
    erreurs, on ne saura jamais que l'agent s'est approché d'un
    incident.

11. **Approvals via canal non-authentifié** — un Slack DM venant d'une
    _autre_ identité pourrait être spoofé si on ne vérifie pas le
    `user_id` Slack. → Lier l'approve à l'identité du canal de manière
    _cryptographique_ (Slack a un `signed_request`).

12. **Step-up qui demande le même secret que l'action initiale** — si
    l'agent a déjà le token, le step-up doit nécessiter un _facteur
    différent_ (humain, MFA, push device). Sinon c'est juste un délai.

---

# Tableau récapitulatif — Si on doit choisir N macro-permissions

| Modèle                                | Buckets                                                                                 | Inspiration                   | Quand le choisir                                        | Pièges à anticiper                                                                               |
| ------------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| **3**                                 | `Read` / `Write` / `Admin`                                                              | Notion, Figma                 | Démarrage rapide, surface API simple, audience non-tech | Pas de capture de la réversibilité, "Write" trop large                                           |
| **4** (recommandé)                    | `Read` / `Write-reversible` / `Write-irreversible` / `Admin`                            | Synthèse OWASP+AWS+MindStudio | **Vaubaan v2** — sweet spot                             | Nécessite annotation par-tool, frontière reversible/irreversible parfois floue (ex. soft-delete) |
| **5**                                 | `List` / `Read` / `Write` / `Destroy` / `Admin`                                         | AWS IAM access levels         | Surface API très large, multi-services                  | `List` vs `Read` souvent confondus par les utilisateurs                                          |
| **6**                                 | `Read-public` / `Read-private` / `Write-safe` / `Write-risky` / `Destroy` / `Admin-IAM` | Google bands × AWS            | Multi-tenant, compliance forte                          | Complexité d'onboarding, expliquer 6 niveaux à l'humain                                          |
| **Hybride (vector + derived bucket)** | Vecteur `(rev, blast, vis, cost, pers, exfil)` → bucket calculé                         | NIST Agentic Profile, Cycles  | Si on veut "policy-as-code" et auto-derivation          | Nécessite un moteur de policy + UI explicative                                                   |

**Recommandation finale** : pour Vaubaan v2, **modèle 4-buckets +
dimension orthogonale `blast_radius`**. Ça donne un vocabulaire
parlant ("write reversible", "write irreversible") _et_ une porte de
sortie pour les actions bulk sans avoir à créer un 5e bucket. À long
terme, migration vers le modèle hybride avec moteur de policy si la
gateway grossit en N providers et N tenants.

---

# Questions ouvertes pour le design Vaubaan

1. **Granularité par-tool vs par-provider** : annote-t-on chaque tool MCP
   avec son vecteur de risque, ou définit-on des templates par provider
   (e.g. tous les `*.delete` GitHub = irreversible) ? Hybride probable,
   mais lequel l'emporte en cas de conflit ?

2. **Identité de l'approver** : un humain peut-il s'auto-approuver ses
   propres requêtes (ex. dev qui lance son propre agent) ? Si oui,
   comment éviter que l'agent ne s'auto-approuve via prompt injection
   sur le canal Slack ?

3. **Approval cache / "remember my answer"** : combien de temps un
   approval reste valide pour des actions similaires ? 5 min ? 1h ? La
   session ? Comment définit-on "similaire" (hash du payload, ou
   sémantique) ?

4. **Multi-tenant approval routing** : pour Vaubaan en mode customer-orgs
   (clients connectent leurs propres clouds), l'approver doit être _du
   tenant client_, pas Vauban Core. Comment Vaubaan provisionne le
   canal Slack/Telegram du client sans onboarding lourd ?

5. **Prompt injection sur le classifieur** : si on va vers une variante
   "Auto Mode" Anthropic-style avec un LLM qui classifie le risque,
   comment empêcher l'agent (ou un attaquant) d'injecter dans le payload
   du tool call de quoi tromper le classifieur ?

6. **Réversibilité contextuelle** : `delete repo` est-il réversible ?
   Techniquement oui (GitHub garde 90 j). Mais socialement non
   (collaborateurs prévenus). Comment représenter cette nuance dans le
   vecteur ?

7. **Granularité du break-glass** : faut-il une procédure break-glass
   _par provider_, _par action_, ou globale ? Combien de temps dure le
   bypass ? Qui peut l'invoquer ? Notif sortante obligatoire à qui ?

8. **Long-poll de 25s : OK comme primitive HTTP, mais MCP** ? Le
   protocole MCP par-dessus stdio/SSE supporte-t-il nativement les
   réponses "pending+poll later" ? Si non, comment le simuler sans
   casser le contrat MCP ?

9. **Bulk detection** : quel est le bon seuil pour passer
   `auto-approve` → `human-required` à cause du bulk ? 2 ? 5 ? 10 ? Le
   pivoter par provider (Vercel deploy = OK en bulk, GitHub delete repo
   = jamais en bulk) ?

10. **Audit log retention** : Five Eyes et NIST exigent traçabilité.
    Quel rétention ? Quels champs ? Stocké côté Vauban Core ou côté
    tenant ? Implications RGPD si l'approver est un identifiant
    personnel ?

---

# Sources consolidées (par axe)

## Axe 1 — Threat modeling

- [LLM06:2025 Excessive Agency — OWASP](https://genai.owasp.org/llmrisk/llm06-sensitive-information-disclosure/)
- [OWASP Top 10 for LLM 2025 — Indusface](https://www.indusface.com/learning/owasp-top-10-llm/)
- [LLM06: Excessive Agency in AI Systems — Indusface](https://www.indusface.com/learning/owasp-llm-excessive-agency/)
- [LLM06: Excessive Agency — FireTail](https://www.firetail.ai/blog/llm06-excessive-agency)
- [NIST AI RMF Agentic Profile v1 — CSA](https://labs.cloudsecurityalliance.org/agentic/agentic-nist-ai-rmf-profile-v1/)
- [Taming Agentic AI: NIST AI RMF — Medium](https://rgutierrez2004.medium.com/taming-agentic-ai-applying-the-nist-ai-risk-management-framework-a7f592e0e97a)
- [NIST-Based Security Governance for AI Agents — Microsoft](https://techcommunity.microsoft.com/blog/microsoftdefendercloudblog/architecting-trust-a-nist-based-security-governance-framework-for-ai-agents/4490556)
- [MITRE ATLAS](https://atlas.mitre.org/)
- [MITRE ATLAS Fact Sheet PDF](https://atlas.mitre.org/pdf-files/MITRE_ATLAS_Fact_Sheet.pdf)
- [MITRE ATLAS Guide — Vectra](https://www.vectra.ai/topics/mitre-atlas)
- [Anthropic Responsible Scaling Policy v3.0](https://www.anthropic.com/responsible-scaling-policy/rsp-v3-0)
- [Anthropic RSP v3.0 Analysis — GovAI](https://www.governance.ai/analysis/anthropics-rsp-v3-0-how-it-works-whats-changed-and-some-reflections)
- [Five Eyes Agentic AI Guidance — Periculo](https://www.periculo.co.uk/cyber-security-blog/what-the-five-eyes-agentic-ai-guidance-actually-means-for-your-organisation)
- [Five Eyes Agentic Guidance — Lyrie](https://lyrie.ai/research/research/2026-05-03-five-eyes-agentic-guidance)
- [Five Eyes Architecture — Rockcyber](https://www.rockcybermusings.com/p/five-eyes-agentic-ai-architecture-not-checklist)
- [Classifying AI Agent Actions by Risk — MindStudio](https://www.mindstudio.ai/blog/classify-ai-agent-actions-by-risk)
- [AI Agent Blast Radius Risk Calculator — Cycles](https://runcycles.io/calculators/ai-agent-blast-radius-risk)
- [When Should a DevOps Agent Act Without Human Approval — DevOps.com](https://devops.com/when-should-a-devops-agent-act-without-human-approval/)
- [Score Your AI Agent's Security Risk — Vaultak](https://vaultak.com/blog/how-to-score-your-ai-agent-security-risk)
- [Prompt Flow Integrity in LLM Agents — arXiv 2503.15547](https://arxiv.org/pdf/2503.15547)
- [EchoLeak Zero-Click Prompt Injection — arXiv 2509.10540](https://arxiv.org/pdf/2509.10540)

## Axe 2 — Macro-permissions

- [AWS IAM Access Levels](https://docs.aws.amazon.com/IAM/latest/UserGuide/access_policies_understand-policy-summary-access-level-summaries.html)
- [AWS Managed Policy AdministratorAccess](https://docs.aws.amazon.com/aws-managed-policy/latest/reference/AdministratorAccess.html)
- [AWS Managed Policy PowerUserAccess](https://docs.aws.amazon.com/aws-managed-policy/latest/reference/PowerUserAccess.html)
- [AWS Managed Policy ReadOnlyAccess](https://docs.aws.amazon.com/aws-managed-policy/latest/reference/ReadOnlyAccess.html)
- [GitHub Fine-Grained PATs — GitHub Blog](https://github.blog/security/application-security/introducing-fine-grained-personal-access-tokens-for-github/)
- [GitHub Fine-Grained PAT Permissions Reference](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens)
- [GitHub Apps vs OAuth Apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/differences-between-github-apps-and-oauth-apps)
- [Stripe Restricted API Keys](https://docs.stripe.com/keys/restricted-api-keys)
- [Stripe API Authentication](https://docs.stripe.com/api/authentication)
- [Slack New OAuth Scopes — Slack Blog](https://medium.com/slack-developer-blog/new-and-improved-oauth-scopes-4894b2cc159d)
- [Slack More Precision Fewer Restrictions](https://medium.com/slack-developer-blog/more-precision-less-restrictions-a3550006f9c3)
- [Slack Scopes Reference](https://api.slack.com/scopes)
- [Google Sensitive Scope Verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification)
- [Google Restricted Scope Verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification)
- [Microsoft Graph Permissions Overview](https://learn.microsoft.com/en-us/graph/permissions-overview)
- [Microsoft Graph Permissions Best Practices](https://learn.microsoft.com/en-us/graph/best-practices-graph-permission)
- [Figma Personal Access Tokens](https://developers.figma.com/docs/rest-api/personal-access-tokens/)
- [Figma REST API Scopes](https://developers.figma.com/docs/rest-api/scopes)
- [MCP Security — SentinelOne](https://www.sentinelone.com/cybersecurity-101/cybersecurity/mcp-security/)
- [MCP Security Risks & Mitigations — SOC Prime](https://socprime.com/blog/mcp-security-risks-and-mitigations/)
- [MCP Authorization Guardrails — Cerbos](https://www.cerbos.dev/news/securing-ai-agents-model-context-protocol)

## Axe 3 — Human-in-the-loop

- [Claude Code Permissions Docs](https://code.claude.com/docs/en/permissions)
- [Claude Code Hooks — Morphllm](https://www.morphllm.com/claude-code-hooks)
- [Claude Code Auto Mode — Anthropic Engineering](https://anthropic.com/engineering/claude-code-auto-mode)
- [Claude Code Auto Approve Guide 2026 — SmartScope](https://smartscope.blog/en/generative-ai/claude/claude-code-auto-permission-guide/)
- [Claude Code Hook Bypass Issue — GitHub #28812](https://github.com/anthropics/claude-code/issues/28812)
- [Claude Code Security Best Practices — General Analysis](https://generalanalysis.com/guides/anthropic-claude-code-security-best-practices)
- [Inside Claude Code Architecture — Penligent](https://www.penligent.ai/hackinglabs/inside-claude-code-the-architecture-behind-tools-memory-hooks-and-mcp/)
- [HumanLayer Key Concepts — DeepWiki](https://deepwiki.com/humanlayer/humanlayer/1.1-key-concepts)
- [HumanLayer SDK — EveryDev](https://www.everydev.ai/tools/humanlayer)
- [HumanLayer YC Launch](https://ycombinator.com/launches/M8e-humanlayer-human-in-the-loop-for-ai-agents-and-beyond)
- [n8n Human-in-the-Loop Tools](https://docs.n8n.io/advanced-ai/human-in-the-loop-tools/)
- [n8n Approval Gates — nNode AI](https://www.nnode.ai/blog/2026-02-05-human-in-the-loop-approval-gates)
- [Human-in-the-Loop AI Agents — Medium](https://medium.com/@arvisionlab/human-in-the-loop-ai-agents-how-to-add-approvals-escalation-and-safe-autonomy-in-production-0a21e359781c)
- [Google ADK + Telegram Human-in-the-Loop — DEV](https://dev.to/jameszh/human-in-the-loop-ai-agents-with-google-adk-and-telegram-5agd)
- [Britive JIT Permissioning](https://www.britive.com/platform/jit-permissioning)
- [Britive Break-Glass Best Practices](https://www.britive.com/resource/blog/break-glass-account-management-best-practices)
- [StrongDM JIT Access Solution](https://www.strongdm.com/solution/just-in-time-access)
- [StrongDM Break-Glass Scenarios](https://www.strongdm.com/blog/break-glass)
- [Opal JIT Access Glossary](https://www.opal.dev/glossary/just-in-time-access)
- [Evolution of PAM Market — SoftwareAnalyst](https://softwareanalyst.substack.com/p/the-evolution-of-the-privileged-access)
- [OAuth Rich Authorization Requests (RAR) — SecureAuth](https://docs.secureauth.com/ciam/en/oauth-rich-authorization-requests--rar-.html)
- [draft-ietf-oauth-rar-23 — IETF](https://datatracker.ietf.org/doc/draft-ietf-oauth-rar/23/)
- [Fine-Grained Consent with RAR — Medium](https://medium.com/@wojciechkotlowskii/fine-grained-consent-with-oauth-rich-authorization-requests-rar-72097fc02172)
- [OAuth CIBA — Auth0 Docs](https://auth0.com/docs/get-started/authentication-and-authorization-flow/client-initiated-backchannel-authentication-flow/user-authorization-with-ciba)

## Axe 4 — Long-polling / blocking-wait

- [WebSockets vs SSE vs Long Polling — IOTools](https://iotools.cloud/journal/websockets-vs-sse-vs-long-polling/)
- [Long Polling vs SSE vs WebSockets — Medium](https://medium.com/@asharsaleem/long-polling-vs-server-sent-events-vs-websockets-a-comprehensive-guide-fb27c8e610d0)
- [WebSockets vs SSE vs Polling — RxDB](https://rxdb.info/articles/websockets-sse-polling-webrtc-webtransport.html)
- [Kubernetes Watch + Long Polling + Chunked Encoding — yongli.dev](https://yongli.dev/posts/understanding_kubernetes_watch_mechanism_http_long_polling_and_chunked_transfer_encoding/)
- [Cloudflare Error 524 Reference](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-5xx-errors/error-524)
- [Cloudflare 524 Timeout Fix](https://www.aimadetools.com/blog/cloudflare-524-timeout-fix/)
- [Vercel Functions Limits](https://vercel.com/docs/functions/limitations)
- [Vercel Edge Function Duration Limit (March 2025)](https://vercel.com/changelog/new-execution-duration-limit-for-edge-functions)
- [Configuring Maximum Duration for Vercel Functions](https://vercel.com/docs/functions/configuring-functions/duration)
- [Serverless Vercel & Cloudflare Workers Guide](https://www.digitalapplied.com/blog/serverless-functions-vercel-cloudflare-guide)
- [HTTP 504 Gateway Timeout: Causes & Fixes — Authgear](https://www.authgear.com/post/http-504-gateway-timeout/)
- [AWS Lambda Invocation Types — Medium](https://medium.com/aws-serverless-microservices-with-patterns-best/aws-lambda-invocation-types-e279ef136347)
- [AWS Lambda Best Practices for Durable Functions](https://aws.amazon.com/blogs/compute/best-practices-for-lambda-durable-functions-using-a-fraud-detection-example/)
- [Streaming AI Agents with SSE — Medium](https://akanuragkumar.medium.com/streaming-ai-agents-responses-with-server-sent-events-sse-a-technical-case-study-f3ac855d0755)
