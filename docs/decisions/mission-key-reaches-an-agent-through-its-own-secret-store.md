---
title: A mission is added to an agent by the agent's own mechanism — a coding agent keeps the key in its own configuration, outside the project; Claude Desktop keeps it in the Keychain
status: accepted
date: 2026-11-27
author: Renaud Pelissier (product owner), drafted with Claude
---

# A mission is added to an agent by the agent's own mechanism — a coding agent keeps the key in its own configuration, outside the project; Claude Desktop keeps it in the Keychain

## Context

Between a mission and its agent's first call, two copy-pastes were left: the key into an
environment variable, which means a shell profile to edit, and the MCP configuration into the
client's file. A desktop assistant has no environment to export into, and Claude Desktop reaches a
server on `localhost` only as a local extension: its remote connectors start from Anthropic's
cloud. The gateway keeps a digest of a mission key, never the key
([mission-token-sha256-digest](mission-token-sha256-digest.md)): it is on the page once. A mission
key is made to be handed to an agent: it opens one mission, within its limits, and its holder
revokes or replaces it from the mission. Checked in the vendors' documentation on 2026-11-27:
`claude mcp add` writes, by default, in `~/.claude.json`, outside the project; Codex reads
`~/.codex/config.toml`, and its `mcp add` takes a bearer token only by the name of a variable; a
Claude Desktop extension (`.mcpb`) keeps a field marked `sensitive` in the system's secret store.

## Decision

Each agent is added by its own mechanism, started by the person; Vaubaan writes into no file of
another application.

- **Claude Code and Codex**: the page that shows the key gives one line to run. The key goes, in
  clear, into the agent's own configuration in the person's home (`~/.claude.json`, by
  `claude mcp add` at its default scope; `~/.codex/config.toml`, by a table the line appends), never
  into a file of the project. The page says which file holds the key and that it is revoked from
  the mission.
- **Claude Desktop**: the instance serves, per mission, a `.mcpb` (named after the mission, a
  relay from standard input to the instance's `/mcp`, no key inside). The person opens it and
  pastes the key once into its `sensitive` field.
- The configuration that names an environment variable stays in the kit, for a file a team commits
  (`.mcp.json`) and for any other client: that one never holds the key.

## Consequences

- No shell profile and no file to edit: one line in a terminal, or one file to open and one paste.
- A key in `~/.claude.json` or `~/.codex/config.toml` is read by whatever reads the person's home
  (backups, sync tools, other programs). The answer is the mission's own: narrow permissions,
  limits, and a key revoked in one click.
- A key never lands in a repository by this path: neither line writes in the project, and the
  page never shows a project file with the key in it.
- The instance builds an archive per mission and ships a relay script: code that runs inside
  another vendor's application, kept as small as a relay can be.
- Left to trials on a Mac: whether Claude Desktop installs an unsigned `.mcpb` and with what
  warning; whether its `sensitive` field is in the Keychain and in no file; whether Claude Desktop
  reads a server's instructions; whether the ChatGPT desktop app, which shares Codex's
  configuration, reaches the mission through the Codex line.

## Rejected alternatives

### The key in an environment variable, for every agent

What the kit did: nothing in a file, but a variable to export in every shell, hence a profile to
edit, and no answer for an assistant that is not started from a shell.

### A helper command that hands the key from the Keychain (`headersHelper`)

The key in no file, at the price of a bridge between the page and the desktop app, a helper
binary and a Keychain item per mission, for a key that is narrow and revocable by design.

### Vaubaan writes the client's configuration file itself

No paste at all, but another application's file edited behind its back, in a format its vendor
may change.

### A Cursor install link, a ChatGPT connector

Cursor is out of scope for now. ChatGPT's connectors reach remote servers only, from OpenAI's
cloud, with OAuth or no authentication: not an instance on `localhost` with a mission key.
