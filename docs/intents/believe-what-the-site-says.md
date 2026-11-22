---
title: Believe what the site says
status: proposed
actors: [developer, consultant, team-lead, security-reviewer, plugin-author]
spec: ../spec/website.md
last_reviewed: 2026-11-22
---

# Believe what the site says

As a person deciding whether to give Vaubaan my accounts, I want every claim on the site backed by
a run, a number or a document I can check, so that I trust it before I install it.

## Prove the claims with real runs

### See which plugins ran against their real service

status: proposed
relieves: services-nobody-ran-for-real, no-outside-proof, trust-that-never-comes
delivers: proof-that-it-works
requires: plugin-health
spec: ../spec/website.md#2-content
acceptance:

- Each plugin page says which tools last ran against the real service, and on which date
- The known limitations page no longer keeps that list by hand
- A plugin with no live run says so on its page and in the project's caveats

### Read the time a call spends in the gateway

status: proposed
relieves: marketing-before-facts
requires: site
spec: ../spec/website.md#2-content
acceptance:

- Each release publishes a measured median and 95th percentile of the time the gateway adds to a call, per door
- The How it works page shows these numbers with the release they come from

### See a real agent client run a mission

status: proposed
relieves: no-outside-proof
requires: site
spec: ../spec/website.md#2-content
acceptance:

- Claude Code and Cursor each ran a mission against a live instance on GitHub, recorded in the known limitations with its date
- The landing's FAQ no longer says that no person has run Claude Code against a running instance

## Read the site in my own project's examples

### Read the site as a developer or as a consultant

status: implemented
delivers: examples-in-my-own-work
requires: site
anchors: apps/website/src/components/site/Project.tsx, apps/website/src/components/site/Landing.tsx, apps/website/src/components/site/ProductPageView.tsx, apps/website/src/site/landing.ts, apps/website/src/site/product-pages.ts, apps/website/src/site/drawings.ts, apps/website/drawings/gen.py, apps/website/src/app/consultants/page.tsx, apps/website/tests/unit/site/product-pages.test.ts, apps/website/tests/unit/site/drawings.test.ts
spec: ../spec/website.md#21-landing--

### Read each service's page from the catalog

status: proposed
requires: site
spec: ../spec/website.md#23-plugins--plugins-pluginsid
acceptance:

- Every page under `/plugins` is built from the signed catalog, including a plugin published after the site's last release
- A plugin that leaves this repository keeps its page, unchanged

## Understand it before I give it my accounts

### See an agent refused before I install anything

status: implemented
requires: site
anchors: apps/website/src/site/landing.ts, apps/website/src/components/site/Landing.tsx, apps/website/tests/unit/site/product-pages.test.ts
delivers: see-it-refuse-before-i-install
spec: ../spec/website.md#21-landing--

### Read how a permission is decided

status: implemented
delivers: deciding-without-installing
requires: site
anchors: apps/website/content/docs/concepts/permissions.mdx, apps/website/content/docs/concepts/how-a-call-flows.mdx, apps/website/tests/unit/site/sources-agree.test.ts
spec: ../spec/website.md#22-user-docs--docs

### Look up a refusal, a trust level or a word

status: implemented
requires: site
anchors: apps/website/src/content/references.ts, apps/website/content/docs/reference/index.mdx, apps/website/tests/unit/site/references.test.ts, apps/website/tests/unit/site/sources-agree.test.ts
spec: ../spec/website.md#22-user-docs--docs

### Find my path in the docs

status: implemented
requires: site
anchors: apps/website/content/docs/index.mdx, apps/website/content/docs/meta.json, apps/website/tests/unit/site/site.test.ts
spec: ../spec/website.md#22-user-docs--docs

## Check the project without trusting it

### Hand my security reviewer one document

status: proposed
relieves: five-pages-to-assemble-for-one-ticket, my-security-reviewer-says-no
delivers: one-document-for-my-ticket
requires: trust-center
spec: ../spec/website.md#25-trust-center--trust
acceptance:

- `/trust/review-pack` serves one HTML page and its Markdown twin: proposition, controls, accepted risks, what leaves the instance, supply chain, limitations, version
- Every section is generated from its source in the repository, never written by hand

### Read how Vaubaan handles my Google data

status: implemented
requires: site
anchors: apps/website/src/content/privacy.ts, apps/website/src/app/privacy/page.tsx, apps/website/src/components/Shell.tsx, apps/website/tests/unit/site/privacy.test.ts
spec: ../spec/website.md#25-bis-privacy--privacy

### Follow releases without an account

status: proposed
requires: site
spec: ../spec/website.md#24-bis-versions-feed--versionsjson
acceptance:

- An Atom feed of releases and security advisories is served from the same source as the versions feed
- Subscribing asks nothing and the site still collects nothing about the reader

### Keep the README's pitch in step with the site

status: implemented
requires: site
anchors: README.md, apps/website/src/site/landing.ts, apps/website/tests/unit/site/product-pages.test.ts
spec: ../spec/website.md#21-landing--
