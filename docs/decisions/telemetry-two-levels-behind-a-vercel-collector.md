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
- No report carries a time or a stable instance identifier: the collector stamps the arrival hour,
  the profile carries a random identifier per UTC day.
- Vercel keeps the caller's address in runtime logs for its base window; the project has no Log
  Drain, which would lengthen it silently.
- The gateway never depends on the collector: a dead one costs a bounded queue.

## Rejected alternatives

### Insert directly into Supabase from the instance

Supabase would log every instance's address.

### A random stable instance identifier, or a salted address hash

The stable instance identifier §9 forbids.

### Deriving error classes from error names or messages

An identifier can carry a table name; only fixed keywords travel.

### A Cloudflare Worker as the proxy

Logs could be switched off, but one vendor and one stack for the site and its collector won.
