---
title: A security reviewer who never uses it and can forbid it
status: hypothesis
evidence:
  - ../research/2026-11-19-personas.md
  - ../research/2026-11-20-facade.md
last_reviewed: 2026-11-22
---

# A security reviewer who never uses it and can forbid it

The CISO, or the CTO who stands in for one, asked by a team lead to say yes or no before the team
installs Vaubaan. They read the trust center and the threat model; they gain nothing from the
product and can block it. The job: decide without installing, from facts, and file the decision.
The research ranks their friction as costlier than the developer's, because nothing keeps them.
Desk research only: one real review ticket would validate what they ask for.

## Pains

- **Marketing before facts** — a page that sells before it says what it covers.
- **Third-party code beside decrypted credentials** — a plugin runs in the process that holds every credential; its signature says who built it, not that it is harmless.
- **No outside proof** — no third-party audit, community validation still empty, few plugins proven against their real service.
- **The record cannot leave** — the activity stays in the instance, ninety days by default, with no export to our collector.
- **Five pages to assemble for one ticket** — the controls, the accepted risks, what leaves the instance and the supply chain live on separate pages.

## Gains

- **What is not covered, written plainly** — the accepted risks, numbered, written by the project itself.
- **Every control traced to a test** — a claim I can check in the code.
- **One document for my ticket** — everything I need in one page I can attach.
- **Deciding without installing** — I read; I run nothing.
