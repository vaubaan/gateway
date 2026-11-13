---
title: Plugin contract, credential spec, macro-actions and the single registry
status: accepted
date: 2026-10-13
---

# Plugin contract, credential spec, macro-actions and the single registry

## Context

Plugins are the unit of community contribution, so a third party depends on their API. The v4 code
had no such API: plugins were duck-typed adapters importing the gateway's row types, every catalog
had a hand-mirrored TypeScript twin, the provider list was duplicated in eleven places, and
credential acquisition was spread over provider-specific routes.

## Decision

A plugin is a `ProviderPlugin` validated by `definePlugin` at import; it imports
`@vaubaan/plugin-sdk` only and knows neither the mission, the accepted risks nor the budget. It
declares how it is connected (`CredentialSpec`: `api-key`, `oauth2`, `ssh-key`) and the host runs
every flow; its YAML catalog is its only catalog artefact. One `PluginRegistry` is built from the
shipped plugins, and nothing else in the repository enumerates providers.

## Consequences

- A plugin is written, tested and reviewed without the gateway; it receives `fetch` injected, never
  reads `process.env`, and never sees a client secret or the stored ciphertext.
- A catalog risk is never renamed or removed, only `deprecated` with `replaced_by`; macro-actions
  ship in the catalog and what they write is copied into the mission policy at issuance.
- Every plugin runs the SDK test kit (well-formed, catalog coverage, no wildcard, macro-actions,
  identifiers); `plugins/_template` is the reference.
- Changing this contract breaks third-party plugins: it moves only by a decision, with the
  versioning rules of the [plugin-sdk handbook](../handbook/plugin-sdk.md).

## Rejected alternatives

### Keep the duck-typed adapter and document it

A contract that lives in the host's call sites cannot be discovered, and nothing stops a plugin
from importing the gateway.

### Plugins implement their own connect routes

Spreads OAuth security details (PKCE, state, redirect validation) across code by different authors.

### Keep the TypeScript catalog twins

Two sources of truth for the security artefact under review.

### Persist a macro-action or trust level reference on the mission

A macro-action changed in a later plugin version would silently alter running missions.

## Amendment 2026-10-31: a slim, versioned contract and one way to call a provider

### Context

The SDK was about to be published for plugins written outside the repository, and the contract
carried hooks no host called (`normalizeForCaps`, `normalizeArgs` behind a flag shipped off), the
main entry re-exported 1 400 lines of git wire code one plugin uses, twelve plugins each wrote
their own `fetch → 401/403 → status → JSON` wrapper and five their own JSON-RPC client, and the
package had kept version 0.1.0 through several breaking changes.

### Decision

- The contract holds only what a host uses. `normalizeForCaps`, `normalizeArgs` and the host flags
  are removed; a later cap stage adds its hook back as an optional member.
- Three entry points: `@vaubaan/plugin-sdk` (the contract, the catalog, the transport),
  `@vaubaan/plugin-sdk/testing` (the kit, with what plugin tests need of the policy engine) and
  `@vaubaan/plugin-sdk/git` (the git wire code and `GitRemoteCapability`). A plugin imports these
  and nothing else of the gateway, its tests included: a lint rule holds it.
- The SDK's transport is the one way to call a provider: `httpJson` (or `upstreamFailure` and
  `readBounded` for a body read by hand) and the upstream MCP client (`mcpRequest`,
  `callUpstreamTool`). An answer is bounded, read through a type guard (`readShape`), and a failure
  is thrown typed: `UpstreamAuthError` for 401/403, `UpstreamHttpError` for another status,
  `UpstreamProtocolError` (502) for an answer the protocol does not allow, a JSON-RPC error frame
  included.
- The SDK has its own semver: it moves when the contract moves, a breaking change is a minor before
  `1.0.0`, and each is listed under "Plugin SDK" in the changelog
  ([handbook](../handbook/plugin-sdk.md), Versions of the SDK).

### Consequences

- Plugins written before the transport are listed in `plugin-transport.test.ts` and leave the list
  one by one; Miro is the worked example.
- The kit and a structural test walk slices and catalog patterns on the data model
  (`assertSlicesOnDataModel`, `catalogPathIssues`); the check joins `definePlugin` once the shipped
  catalogs have no known gap.
- Publishing needs `@vaubaan/shared` and `@vaubaan/policy-engine` published or inlined; inlining is
  recommended.

### Rejected alternatives

#### Keep the reserved hooks so a future cap stage is not a contract change

Every external author reads and reviewers carry members no host calls; adding an optional member
later is a non-breaking change.

#### A transport helper per protocol in each plugin, with a shared checklist

The checklist is what drifted: twelve copies of the 401/403 rule, the caller's `signal` dropped in
some, unbounded reads in all.

## Amendment 2026-11-05: what a plugin declares for its public page

### Context

The site's plugin page ([website](../spec/website.md) §2.3) shows the risk model of a service: the
map of its permissions, one narrative per macro-action, worked calls with the slices and
permissions they touch, the tools left out on purpose, and how an account is connected. Three of
those contents nothing declares today: the narrative (`macro_actions[].description` is one line),
the tools a classifier refuses by name (GitHub keeps them in a constant of `identity.ts`, Supabase
in the spec), and the worked calls — which exist as the tool samples every plugin's tests run
through the kit (`ToolSamples`, risk model §15), invisible to a build of the site. The connect
page also described every `oauth2` way as a client the gateway registers, which is false for a
brokered one.

### Decision

- A catalog macro-action may carry a `narrative` ([gateway-risk-model](../spec/gateway-risk-model.md)
  §4.6).
- `ProviderPlugin` gains two optional members. `excludedTools: Record<toolName, reason>` names the
  tools of the provider the plugin deliberately does not expose, with one sentence each; such a
  name is never a declared tool, and `classify` keeps refusing it. `examples: ToolSamples` holds the
  tool samples: the test kit reads them from the plugin instead of the test file, and the site
  runs `classify` on them when it builds, so a page shows slices the classifier really emits.
- Both are optional members: a non-breaking change, a minor of the SDK. Every plugin shipped with
  the gateway fills `narrative`, `examples` and, where the risk model names a left-out tool,
  `excludedTools` (structural tests, as for `summary`).
- A page or a connect guide names the client source of an `oauth2` way: registered by the gateway
  (`clientRegistration`) or a broker's (`broker`), never one for the other.

### Consequences

- The site imports `@vaubaan/policy-engine` for tiers, gates and budgets and the plugin's
  `classify` for the examples; it restates nothing by hand, so the duplicate severity function of
  the site moves to the policy engine.
- A third-party plugin without these members gets a page without those sections, nothing else.
- `RETIRED_TOOL` of the GitHub plugin becomes its `excludedTools`.

### Rejected alternatives

#### Hand-written examples in the catalog, slices included

A slice written by hand drifts from the classifier the day a grammar changes; computed, it cannot.

#### Prose sections of the plugin README parsed by the site

No schema, no length, no review as code; the connect page already pays for this with its
hand-pointed links.

#### Importing the test files at build time

Test code in the production build of the site, and a sample's shape fixed by a test helper rather
than by the contract.

## Amendment 2026-11-11: alternatives of a pasted key

### Context

A service may make the same key in several shapes that need different companion fields (Vercel:
a token for a team needs the Team ID, a token for one project the Project ID). `CredentialField`
knew no choice between field groups, and a plugin could only declare every field required, or
every one optional with no rule binding them.

### Decision

- `ApiKeyCredentialSpec` gains an optional `alternatives: CredentialAlternative[]` (2 to 4), each
  `{ id, label, help?, fields, steps }`: `fields` names the spec's fields only that alternative
  asks (each in one alternative at most); a field no alternative names is shared; `steps` are
  shown before the guide's own. `definePlugin` checks them, and that each alternative asks a
  secret.
- The host renders a radio before the guide's steps, hides the other alternatives' steps and
  fields, and reads only the shared fields and the chosen alternative's; a form without a choice is
  read under the only alternative whose fields hold a value, otherwise refused. The choice is not
  stored: the fields are plain fields, and the plugin narrows them by which one is there.
- An optional member: a patch of the SDK before `1.0.0` (0.7.1).

### Consequences

- No plugin-specific code in the host; a plugin without alternatives is unchanged.
- A connection made before a plugin added alternatives keeps its fields and keeps working, if the
  plugin infers the mode from them.
- The site lists each alternative's steps prefixed by its label.

### Rejected alternatives

#### Two credential specs per plugin

Breaks "one way per plugin": two `verify`, two guides, two connect pages for one key.

#### Optional fields and a check in `verify`

The form could not say which fields go together, and an error would come back only after a call
to the service.

## Amendment 2026-11-13: menu paths and screenshots in the connect guide

### Context

The guide of a pasted key said where to click inside its sentences ("Open Settings, Developer
settings, …"), so neither the connect screen nor the site could show the path apart, and a person
with the service open had to read every sentence. The site also kept a second connect page
(`/docs/providers/<id>`) built from the README's hand-written "Credential" sections. The owner
decided (2026-11-13, option A of the connect-guide wireframes) that the whole guide lives on the
plugin page and on the gateway's connect screen, from one declaration, with the application paths
highlighted and a screenshot only on the one hard screen of a service, with its provenance.

### Decision

- `GuideStep.path?: string[]`: the provider's own menu labels, in order, 1 to 8 segments of at
  most 40 characters, none empty. A step has a `path`, a `url`, both or neither; the sentence `do`
  never carries the path.
- `GuideStep.screenshot?` names a file declared in `TokenGuide.screenshots?`, a map from file name
  (`^[a-z0-9][a-z0-9-]*\.(png|webp)$`) to `{ source, licence, taken, alt }`. The files live in
  `docs/connect/` of the plugin folder (`GUIDE_SCREENSHOT_DIR`), a convention like
  `risk-catalog.yaml`. Every step's file is declared; every declared file is named by exactly one
  step.
- Provenance is declared, never discovered: `source` is the https page the image was taken from,
  or `ours` for a capture of the Vaubaan team; `licence` is one of `CC-BY-4.0`, `MIT`,
  `Apache-2.0` or `ours` (with `ours` only). A NonCommercial or NoDerivatives licence never ships.
  `taken` is `YYYY-MM`. The line under the image is derived (`screenshotAttribution`): "GitHub docs,
  2026-11 · from docs.github.com (CC BY 4.0)" or "Taken by the Vaubaan team, 2026-11".
- `definePlugin` checks the declaration; a structural test of the gateway checks the files: present,
  PNG or WebP by their magic bytes, at most 300 KB and 1600 px wide, nothing undeclared in the
  folder. Personal data (an e-mail, an avatar, a real token) is the review's to refuse.
- The host serves a file to signed-in users from the plugin's folder, bundled
  (`plugins/<id>/docs/connect/`) or pinned (`<pin>/docs/connect/`, copied by the bundle script);
  the site copies it beside the page.
- `definePlugin` refuses what 0.7 accepted: a minor of the SDK before `1.0.0` (0.8.0).

### Consequences

- The site's `/docs/providers/<id>` becomes a permanent redirect to `/plugins/<id>#connect`; the
  README "Credential" sections are no longer read by the build.
- A pin built against `^0.7` is refused by a 0.8 host until it is rebuilt.
- Screenshots go stale when a provider redesigns its screens: `taken` dates them, and the review
  that refreshes the provider facts retakes them.

### Rejected alternatives

#### The path parsed from the sentence

A sentence in prose has no reliable separators, and a renderer guessing the menus would highlight
the wrong words.

#### Screenshots discovered in the folder, without a declaration

Nothing would say where an image comes from or under which licence, so nothing could refuse one
that may not be redistributed.

#### Images from any documentation, credited

Most providers' documentation is not openly licensed; an allowlist of licences that permit
redistribution with attribution is the only rule a test can hold.
