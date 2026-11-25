---
title: The living history of a mission is the mission log, never a session
status: accepted
date: 2026-11-25
author: Renaud Pelissier
---

# The living history of a mission is the mission log, never a session

## Context

"Session" named three things: the living history of a mission (its events and remaining budget),
a person's signed-in visit to the interface, and the MCP transport's session of an agent's
connection. The spec, the store (`sessions`, `session_counters` beside `web_sessions`) and the code
mixed them, and a reader could not tell which one a rule was about.

## Decision

The living history of a mission is the **mission log**, in the spec, the store and the code;
"web session" is a person's signed-in visit; "session" alone belongs to the MCP transport. The
interface keeps the word **Activity**, which covers the audit and the mission log
([interface-redesign-vocabulary-and-design-system](interface-redesign-vocabulary-and-design-system.md)).

## Consequences

- No new name, column, type or text calls a mission's history a session. Migration 0043 renamed
  the tables in place (`mission_logs`, `mission_log_counters`, every `mission_log_id` column); the
  code says `MissionLog`, `MissionLogCounter`, `MissionLogsRepo`, `MissionLogService`.
- The agents' protocol does not change: no tool answer carries the word.

## Rejected alternatives

### Activity

The interface's word already covers the audit as well as the mission log; giving it to one of
the two would bring the confusion back.

### Keeping "session" and defining "web session" only

Removes one of the three senses in the spec, leaves the code's `sessions` beside `web_sessions`
and the MCP transport's sessions.
