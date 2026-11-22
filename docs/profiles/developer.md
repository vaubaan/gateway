---
title: A developer who gives missions to their coding agent
status: hypothesis
evidence:
  - ../research/2026-11-19-personas.md
  - ../research/2026-11-20-facade.md
last_reviewed: 2026-11-22
---

# A developer who gives missions to their coding agent

A developer, alone on a laptop at first, who has already pasted a token into a coding agent's
configuration. They arrive from the site or GitHub with ten minutes to spare; the job is to let the
agent work on a repository and its database during a meeting, without touching production or
merging. Once convinced, they create missions every day, then bring their team (the team lead).
This profile merges two seats of the research, the evaluator and the mission creator: its hats
table shows the same person in both, and the façade's solo developer starts as one and becomes the
other. Desk research, not interviews: five developers trying it would validate or correct the rank.

## Pains

- **A lost evening on pre-release software** — trying it today means a runtime to install, a clone, a build and about twenty steps before my agent's first governed call.
- **A token that can do anything** — the agent's configuration holds a credential with all my rights; my client's "allow once / always" asks per tool, only while I watch, and never reads the arguments.
- **Interrupted all the time, or not when it mattered** — I want to leave for lunch, not come back to a merge on main.
- **Relaying my yes by hand** — after I approve, nothing tells the agent; I must come back and tell it to replay the call before the approval lapses.
- **Four copy-pastes per project** — the key shown once, a variable to export, a client block, an instruction block, a git helper.
- **A permission that silently needs a label** — a permission bound to `prod` is granted only when a chosen resource carries that label, and nothing says so while I create the mission.
- **An agent that keeps hitting walls** — it sees tools it may not call, tries them, is refused, and retries without knowing whether anything changed.

## Gains

- **My agent works alone on real things** — an hour of real work on real resources, nothing asked, everything recorded: the silence.
- **Stopped at the right place** — the one grave action waits for me with the exact call in clear, decided in ten seconds: the yes.
- **See it refuse before I install** — a refused call and a call waiting for a yes, with their reason, on the first screen.
- **My first governed call in minutes** — on my own account, on my own computer, with no server and no domain name.
- **Never handing over a credential** — the agent holds a mission key; my credentials stay encrypted in Vaubaan.
- **Bringing my team later without starting over** — the same missions move to a server the team shares.
