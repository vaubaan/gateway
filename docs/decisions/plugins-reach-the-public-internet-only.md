---
title: Plugins reach the public internet, and inside the network only what the operator lists
status: accepted
date: 2026-11-19
---

# Plugins reach the public internet, and inside the network only what the operator lists

## Context

Some services take their address from the person who connects the account (a CalDAV server
URL), and the connect flow calls it at once with the credential. With an unrestricted `fetch`,
any signed-in person could make the instance probe its loopback, its cloud metadata endpoint and
its network, and read whatever answers through the plugin's tools. Yet an on-prem gateway must
reach some internal services on purpose (a company's Nextcloud).

## Decision

The `fetch` the host hands to plugins and to the services' token endpoints connects to public
addresses, and to the host names, addresses and ranges listed in `plugins.private_hosts`, nothing
else. It is enforced on each socket the request opens, redirects included: an address is refused
before connecting, a name is refused when any of its addresses is not allowed, and the connected
peer is checked again (DNS rebinding).

## Consequences

- A plugin never opens its own HTTP client: it uses the `fetch` of its context, or its traffic
  escapes the rule.
- An internal service a plugin must reach is named in `plugins.private_hosts` by the operator;
  nothing in the interface widens it.
- The OAuth brokers, the sign-in providers and the notification channels keep their own rules:
  their addresses are the operator's, or checked by their own module.
- Plugins that open sockets themselves (`ssh`) are outside this rule; their reach is theirs to
  document.

## Rejected alternatives

### Check the URL once, then call the plain `fetch`

A name can resolve differently between the check and the connection, and a redirect is followed
without a check.

### Per-plugin host rules in the plugin

Each plugin would re-implement address checks; a missed one is an SSRF, and the operator would
have no single place to open a range.
