---
title: What is executed is what was classified — one grammar per identifier, a closed argument surface, refuse never escape
status: accepted
date: 2026-10-13
---

# What is executed is what was classified

## Context

The gateway decides a call from the slices `classify` returns, then hands the same arguments to
`execute`. The template let `widget_id: '..'` be classified as a widget and sent to the parent
endpoint (URL parsers remove dot segments), and executors forwarding the whole argument object sent
arguments the classifier never read (`teamId`, `force`, a second `id`). Every shipped plugin had a
variant of the flaw.

## Decision

`classify` and `execute` read every identifier through the same grammar function, one per kind,
fitting where the value lands, and `execute` builds its request only from what that reader
returned. A value outside its grammar, or an argument the tool's schema does not declare, is
refused in both, never repaired, escaped or dropped.

## Consequences

- The SDK kit's `assertIdentifiersRefused` runs every plugin's `classify` and `execute` on hostile
  values; every plugin directory, the template included, calls it.
- A new argument must be declared in the schema before classifier or executor can use it.
- An identifier the slice grammar cannot carry is classified as "any" (`*`): the call needs a
  mission covering every instance of the entity.
- Values a provider would accept but the grammar does not are refused, naming the argument;
  widening a grammar is a reviewed change with its tests.

## Rejected alternatives

### Escape instead of refuse

`.` and `..` survive `encodeURIComponent`, and a value that needed escaping was classified
unescaped: the defect itself.

### Drop undeclared arguments silently

The call the agent believes it made and the one that ran would differ.

### A single grammar in the SDK, or validation in the host

Identifier shapes differ per provider, and the host knows neither which argument is an identifier
nor where it lands.
