---
title: Believe what the site says
status: proposed
actors: [user, administrator]
spec: ../spec/website.md
last_reviewed: 2026-11-20
---

# Believe what the site says

As a person deciding whether to give Vaubaan my accounts, I want every claim on the site backed by
a run, a number or a document I can check, so that I trust it before I install it.

## Prove the claims with real runs

### See which plugins ran against their real service

status: proposed
requires: plugin-health
spec: ../spec/website.md#2-content
acceptance:

- Each plugin page says which tools last ran against the real service, and on which date
- The known limitations page no longer keeps that list by hand
- A plugin with no live run says so on its page and in the project's caveats

### Read the time a call spends in the gateway

status: proposed
requires: site
spec: ../spec/website.md#2-content
acceptance:

- Each release publishes a measured median and 95th percentile of the time the gateway adds to a call, per door
- The How it works page shows these numbers with the release they come from

### See a real agent client run a mission

status: proposed
requires: site
spec: ../spec/website.md#2-content
acceptance:

- Claude Code and Cursor each ran a mission against a live instance on GitHub, recorded in the known limitations with its date
- The landing's FAQ no longer says that no person has run Claude Code against a running instance

## Read the site in my own project's examples

### Read the site as a developer or as a consultant

status: proposed
requires: site
spec: ../spec/website.md#21-landing--
acceptance:

- A switch on every page shows the examples and drawings of a developer on GitHub and Supabase, or of a consultant on Gmail, Notion and Google Calendar
- The switch works without JavaScript and is remembered on this browser only
- The consultants' page opens on the consultant's examples

### Read each service's page from the catalog

status: proposed
requires: site
spec: ../spec/website.md#23-plugins--plugins-pluginsid
acceptance:

- Every page under `/plugins` is built from the signed catalog, including a plugin published after the site's last release
- A plugin that leaves this repository keeps its page, unchanged

## Check the project without trusting it

### Hand my security reviewer one document

status: proposed
requires: trust-center
spec: ../spec/website.md#25-trust-center--trust
acceptance:

- `/trust/review-pack` serves one HTML page and its Markdown twin: proposition, controls, accepted risks, what leaves the instance, supply chain, limitations, version
- Every section is generated from its source in the repository, never written by hand

### Read how Vaubaan handles my Google data

status: proposed
requires: site
spec: ../spec/website.md#25-bis-privacy--privacy
acceptance:

- `/privacy` and its Markdown twin say what Vaubaan's OAuth broker keeps, what it never keeps, and that calendar data goes only to the person's own instance
- The page carries Google's Limited Use sentence word for word, and the URL is the one on Google's consent screen
- Every page of the site links to it from its footer

### Follow releases without an account

status: proposed
requires: site
spec: ../spec/website.md#24-bis-versions-feed--versionsjson
acceptance:

- An Atom feed of releases and security advisories is served from the same source as the versions feed
- Subscribing asks nothing and the site still collects nothing about the reader

### Keep the README's pitch in step with the site

status: proposed
requires: site
spec: ../spec/website.md#21-landing--
acceptance:

- A check fails when the README's first lines differ from the landing's defining sentence and promise
