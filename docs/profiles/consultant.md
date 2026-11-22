---
title: A consultant whose assistant works on their mail, notes and calendar
status: hypothesis
evidence:
  - ../research/2026-11-20-facade.md
  - ../research/2026-11-19-personas.md
last_reviewed: 2026-11-22
---

# A consultant whose assistant works on their mail, notes and calendar

An independent consultant, not a developer, who uses a desktop assistant. The job: the assistant
reads the mail, the calendar and the notes, prepares the weekly client recap, and never sends a mail
to a client without them. They hold the same seats as the developer (evaluator, then mission
creator) on other services; the façade gives them a journey of their own because what blocks them
differs: no terminal, no configuration file. Desk research only, and none of their services has
yet run against the real service: a few consultants trying the desktop app would validate it.

## Pains

- **No way to try without a terminal** — every path today starts with a container or a runtime: "I don't do Docker."
- **A mail sent to a client without me** — the assistant must never write to a client on its own.
- **A configuration file to edit** — desktop assistants expect a sign-in or a bridge, not a header pasted into a file.
- **My own Google client to create** — the calendar needs an OAuth client registered at Google, which I cannot make.
- **Services nobody ran for real** — my mail, notes and calendar have never been tried against the real service.

## Gains

- **The client mail stopped and shown before it leaves** — the recipient, the subject and the text, then my yes or no.
- **The recap prepared while I do something else** — the assistant reads, sorts and drafts without asking me.
- **Installed like any other app** — a signed installer on macOS or Windows, nothing else to set up.
- **Examples in my own work** — the site shows mail, notes and a calendar, not repositories.
