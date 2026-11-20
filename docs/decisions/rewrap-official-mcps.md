---
title: Rewrap a provider's official MCP server when it is remote HTTP; synthesise from the API otherwise
status: accepted
date: 2026-05-23
---

# Rewrap a provider's official MCP server when it is remote HTTP; synthesise from the API otherwise

## Context

A plugin can expose a provider's tools by rewrapping its official MCP server or by synthesising
them from the provider's API. Some official servers are remote HTTP and accept a Bearer (Vercel,
Railway, Context7, Miro); others are local stdio processes (GitHub, Supabase), which would mean a
subprocess and a package fetched at run time, with third-party code holding the credential. Rewrapped
servers also lack tools agents need (Vercel settings and env vars, Railway variables).

## Decision

A remote HTTP official server that accepts the stored credential is rewrapped: the plugin forwards
JSON-RPC with the `<provider>__` prefix stripped and freezes the upstream tool list in
`upstream-tools.json`; its gaps are filled by a few typed tools calling the provider's API. A
stdio-only server is never run: the plugin synthesises its tools from the API.

## Consequences

- Every tool, rewrapped or not, goes through the same classification, policy and audit; an upstream
  tool the catalog does not price is refused.
- Refreshing the upstream list is a re-fetch and a commit; a schema changed in place upstream
  drifts until then.
- Gap-filling tools have strict input schemas (no passthrough) and are reviewed one by one; they
  are removed once the provider's server ships the same tool.
- A tool never returns the stored credential: on providers with account-wide tokens it would
  bypass the policy.

## Rejected alternatives

### Rewrap everything, stdio servers in sidecars

A process to operate per provider, and third-party code holding the credential, for tools the API
gives directly.

### Synthesise everything

Duplicates a maintained remote server and loses its new tools for free.

## Amendment 2026-11-20: the reads an agent needs first do not depend on the upstream tool list

### Context

In dogfood, Vercel's MCP server dropped `get_deployment_build_logs` ("Tool not found"), renamed
`get_project`'s argument to `idOrName`, and wrapped every answer in `{ "result": … }`, which the
project redaction replaced whole, so `list_projects` answered nothing. A frozen list drifts the day
the server changes, and an agent then cannot even find its project.

### Decision

The reads an agent needs to find its way (list and read its projects, list and read a deployment,
read its build logs) are served from the provider's API, under the same names and declared schemas,
whatever the server lists; a list of mission resources is answered from the resources the gateway
holds. The other rewrapped tools are still forwarded. A `tools/call` the server answers "tool not
found" is an `UpstreamToolMissing` (plugin SDK) whose message names the plugin as behind the
service. Applied to Vercel 4.3.0 first.

### Consequences

- Those reads keep working when the server changes; the server's new tools come in at refresh time.
- A synthesised read carries its own reviewed request and answer shape, as the gap-filling tools do.
