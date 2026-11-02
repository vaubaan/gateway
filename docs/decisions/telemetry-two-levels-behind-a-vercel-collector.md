---
title: Telemetry reports are built from closed vocabularies by one shared package and received by a Vercel function in front of an insert-only Supabase
status: accepted
date: 2026-10-16
---

# Telemetry reports are built from closed vocabularies by one shared package and received by a Vercel function in front of an insert-only Supabase

## Context

Trust in plugins comes from usage, so opted-in instances report it, but spec §9 forbids arguments,
identifiers, resource refs and network addresses. Providers echo input in their errors, so any
field derived from free text can leak. A hosted Supabase logs the caller's address and cannot be
told not to. Handbook [telemetry](../handbook/telemetry.md).

## Decision

Every report is rebuilt through the constructors of `@vaubaan/telemetry`, which admit only closed
vocabularies, shapes bounded by the plugin's declaration, or buckets; the same package serializes
on the instance and parses on the collector. The collector is a function of the site's Vercel
project that inserts as `anon` into insert-only tables whose `CHECK` constraints repeat the
vocabularies; telemetry is off by default and disabled means zero requests.

## Consequences

- A new field must fit the closed-vocabulary rule; no string from an argument, result, error,
  provider or company-chosen label (risks travel without their environment qualifier).
- No report carries a time: the collector stamps the arrival hour. No call report carries an
  instance identifier; the profile carries the framed one of the amendment below (it carried a
  random identifier per UTC day until 2026-11-02).
- Vercel keeps the caller's address in runtime logs for its base window; the project has no Log
  Drain, which would lengthen it silently.
- The gateway never depends on the collector: a dead one costs a bounded queue.

## Rejected alternatives

### Insert directly into Supabase from the instance

Supabase would log every instance's address.

### A random stable instance identifier, or a salted address hash

A salted address hash stays rejected. A random stable identifier was rejected here, then adopted
within a frame: see the amendment of 2026-11-02.

### Deriving error classes from error names or messages

An identifier can carry a table name; only fixed keywords travel.

### A Cloudflare Worker as the proxy

Logs could be switched off, but one vendor and one stack for the site and its collector won.

## Amendment 2026-11-02 — a stable instance identifier, framed

Owner decision. The daily identifier counted the instances of one day and nothing else: the site
could not say how many gateways run a plugin version, which is the figure a reader of
`/plugins` asks first, and a count summed over days over-counted every instance by the number of
days it reported. The profile it travels with is low-sensitivity (buckets, closed vocabularies, the
hour of arrival), and peers that publish usage (Homebrew, Docker Desktop, Next.js) use a stable
random identifier and say so.

The frame:

- 128 random bits (`instance_id`, 32 hex characters), drawn by the gateway the first time it needs
  one and kept in its store (`instance_config`, key `telemetry.instance_id`);
- sent in the instance profile only, so only at level `usage-stats`; never in a plugin-health or
  decision report, so no call is attributable to an instance;
- the collector still truncates arrival to the UTC hour and keeps no address;
- shown on Administration → Telemetry, where an administrator regenerates it (an audited
  `config-changed`); a restore from a backup keeps it;
- published only as counts: distinct identifiers per plugin, version and minor over the window
  (`public.plugin_instances`).

The plugin-health success rate leaves out `credential_rejected` in the same change: a revoked token
is the user's configuration, not the plugin.
