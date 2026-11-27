---
title: A mission key reaches an agent through the agent's own install mechanism and a secret store, never in clear in a file, and Vaubaan writes no other application's file
status: proposed
date: 2026-11-27
author: Renaud Pelissier (product owner), drafted with Claude
---

# A mission key reaches an agent through the agent's own install mechanism and a secret store, never in clear in a file, and Vaubaan writes no other application's file

## Context

Between a mission and its agent's first call, two copy-pastes are left: the key into an environment
variable, the MCP configuration into the client's file. A desktop assistant has no environment to
export into, and Claude Desktop reaches a server on `localhost` only as a local extension: its
remote connectors start from Anthropic's cloud. The gateway keeps a digest of a mission key, never
the key ([mission-token-sha256-digest](mission-token-sha256-digest.md)): it is on the page once.
Checked in the vendors' documentation on 2026-11-27: a Claude Desktop extension (`.mcpb`) may
declare a field `sensitive`, kept in the operating system's secret store, and has no per-user
prefill; Claude Code takes a server's headers from a command (`headersHelper`), run at each
connection and never cached; neither documents an install link.

## Decision

The key is never written in clear in a file, and Vaubaan writes into no file of another
application: each agent is added by its own mechanism, started by the person.

- **Claude Desktop**: the instance serves, per mission, a `.mcpb` (a name from the mission, a relay
  from standard input to the instance's `/mcp`, no key inside). The person opens it and pastes the
  key once into its `sensitive` field.
- **Claude Code**: one line to run, `claude mcp add-json` with a `headersHelper`. In the desktop
  app the helper is a command of the app that reads the key from the macOS Keychain, where the app
  put it when the person clicked, while the key was on the page; elsewhere the line names the
  environment variable, as the kit does today.
- **The page-to-app bridge** is one write-only command, "keep this mission key", open to the
  instance's own origin only; the page can never read a key back.
- **Cursor** comes later, by its install link, once its handling of headers is known.

## Consequences

- Six actions hold with one paste left in each path: the key into Claude Desktop, the line into a
  terminal. No path asks to edit a file.
- A key in the Keychain is readable by any process of the person that runs the helper, as a key in
  an environment variable is; it leaves the Keychain when the key is replaced or revoked.
- The instance builds an archive per mission and ships a relay script: code that runs inside
  another vendor's application, to keep as small as a relay can be.
- Left to the trials on a Mac, before this decision is accepted: whether Claude Desktop installs an
  unsigned `.mcpb` and with what warning; whether its `sensitive` field is in the Keychain and in
  no file; whether a helper inside the app bundle reads the Keychain item without a prompt, within
  the ten seconds a `headersHelper` is given; whether Claude Desktop reads a server's instructions.

## Rejected alternatives

### Vaubaan writes the client's configuration file itself

One click and no paste, but another application's file edited behind its back, in a format its
vendor may change, and the key in clear in it for Claude Desktop.

### The key in clear in the client's configuration, said on the page

What `claude mcp add --header` and a Cursor link amount to: a secret in a file that backups, sync
tools and other programs read.

### A relay of the desktop app that authenticates for the agent

The agent would reach the instance with no key of its own: any local process would hold every
mission of the person, and a call would no longer name the key it was made with.
