---
title: A team lead who runs Vaubaan for a team and shares its accounts
status: hypothesis
evidence:
  - ../research/2026-11-19-personas.md
  - ../research/2026-11-20-facade.md
last_reviewed: 2026-11-22
---

# A team lead who runs Vaubaan for a team and shares its accounts

The person who brings Vaubaan to a team of about six after trying it alone: they install and keep
the instance (the spec's administrator, who gets called when it falls over), plug in the shared
accounts at the code host or the database (the account owner), and give each teammate access. The
job: give agents to six people on shared accounts without any of them holding a token. This
profile merges three seats of the research, the evaluator for a team, the administrator and the
account owner: the hats table shows one person wearing all three at six people. At sixty a
platform team splits them; revisit this profile then, with interviews.

## Pains

- **A dozen gestures before any value** — a domain name, open ports, https and a sign-in provider before the first useful page.
- **Losing the master key** — the one secret that opens every stored credential.
- **An update that breaks on a Monday** — a new version of a plugin or of the instance stops the team's agents.
- **A mission on production I know nothing about** — my token sits in the vault and someone else's mission uses it.
- **My security reviewer says no** — without their yes, nothing gets installed.
- **Someone who left stays active** — nothing comes from the sign-in provider; their missions turn orphaned only once an administrator notices.
- **Teammates who land on a mute page** — an invited teammate reaches a sign-in page that says nothing of what Vaubaan is.

## Gains

- **One command, then forget** — install, then nothing to tend but what asks for me.
- **The instance is mine** — finishing the setup revokes the setup link; nobody else holds it.
- **Nobody holds a token** — each person has their own key and the activity says who did what.
- **Each hand gives less** — I share an account permission by permission, never "everything".
- **Every mission on my account, named** — the account's page lists each mission that carries it.
- **My security said yes** — the reviewer read what they needed and agreed.
- **Moving from my computer to the team server** — what I set up alone carries over.
