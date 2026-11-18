---
title: Plugin authoring — writing, signing and shipping a plugin outside the gateway's repository
status: draft
---

# Plugin authoring — spec

> **Status:** draft. Decided 2026-11-17, not built. What a plugin is and how an instance loads it:
> [vaubaan-gateway](./vaubaan-gateway.md) §5 and §4.2 (Administration › Plugins).

## 0. Vocabulary

- **Author** — whoever writes a plugin, alone or with a coding agent; never needs the gateway's
  source.
- **Kit** — what an author installs from the public package registry: the SDK the plugin is
  written against, its test kit, and the command line below.
- **Scaffold** — a new plugin project made in one command: sources of an imaginary service, tests,
  a simulator of the service, a build that signs, and the agent skills.
- **Skill** — instructions an author's coding agent loads to do one step of the work (model the
  service, classify, connect, check, ship, submit, upgrade), each ending on a check a machine runs.
- **Archive** — the one file a plugin ships as: the built plugin, its risk catalog, its manifest of
  file digests, and its signature.
- **Signer** — who signed an archive: the catalog (level "Vaubaan"), or a key an instance trusts by
  name (a company's own key for its private plugins).
- **Submission** — a reviewed change to the catalog declaring a plugin's source and exact revision;
  the catalog rebuilds and signs it, never the author's own archive.

## 1. Vision

An author goes from nothing to a plugin activated on a gateway without reading the gateway's code,
and their agent can do most of it.

- The kit installs from the public registry and works in an empty directory.
- The command line covers the whole path: make the project, try a call without a gateway (its
  slices, permissions and decision against a sample mission), run the kit's checks, run a local
  gateway with the plugin, build and sign, upload to an instance, print what an administrator must
  trust once, submit to the catalog.
- A private plugin is signed with a key of its company, made once by the command line; nothing
  about it is published anywhere. Signing without a key, through a public transparency log, is an
  option for an author who accepts that the log names their source.
- The skills come with every scaffold, for the coding agents the project supports, and stop where
  a human must decide (a write risk, a credential choice, the activation itself).
- When a gateway refuses a plugin built against an older SDK, the refusal names the command that
  rebuilds it, and a skill does the migration.

### 1.1 Explicitly out of scope

- Activating a plugin: always an administrator, in the gateway's interface; neither the command
  line nor a skill does it.
- A store portal with accounts: a submission is a reviewed change to the catalog.
- Paid plugins, licensing, usage metering.
- Plugins in another language than the SDK's.
- Running a plugin outside the gateway's process, or in a sandbox.

## 2. Submission

- The catalog holds one declaration per plugin: id, source and path, version, exact revision,
  owners. Only its owners change it; a new version changes the revision.
- A submitted change is built without any secret; the build reports, for review, the risk catalog,
  each tool's classification, the dependencies added and the execution code's diff since the
  previous version. A write classified as a read is a refusal.
- Once accepted, the catalog rebuilds the same revision, signs it and publishes it with its page
  and its line in the versions feed. A plugin judged dangerous or abandoned gets an advisory, then
  leaves the catalog; instances keep it, with a warning.

## 7. Open questions

- Data migrations, decided 2026-11-17, contract still to write before the SDK's first stable
  version: a plugin declares the format version of its account and resource data and the oldest it
  reads; its migrations are pure and forward only; the instance stores a migrated form beside the
  original, never in place, so going back to an older version reads the original; a version only
  adds fields, and an older one ignores the fields it does not know.
- The SDK's first stable version, so a plugin survives the gateway's minor versions; planned before
  the kit is opened to the public.
- Domain, Security and Tests sections, to write with the first build of the kit.
- The catalog's check (vaubaan/gateway-plugins, `report.sh`) reports the declaration, the risk ids
  and the archive's files; each tool's classification, the dependencies added and the execution
  code's diff (§2) are still to add.
