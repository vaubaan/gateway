---
title: Recognise Vaubaan at a glance
status: proposed
actors: [developer, consultant]
spec: ../spec/style-guide.md
last_reviewed: 2026-11-22
---

# Recognise Vaubaan at a glance

As a person moving between the site and my instance, I want one mark, one accent and the same parts
everywhere, so that I recognise Vaubaan and read a risk or a refusal the same way on every page.

## Read the site in the Trace identity

status: implemented
requires: token, component
anchors: apps/website/src/app/globals.css, apps/website/src/app/layout.tsx, apps/website/src/components/Lockup.tsx, apps/website/src/components/ui/button.tsx, apps/website/src/app/icon.svg, apps/website/src/app/opengraph-image.png, packages/design-tokens/src/palette.ts, apps/website/tests/unit/site/trace-identity.test.tsx, packages/design-tokens/tests/unit/contrast.test.ts
spec: ../spec/style-guide.md#3-tokens

## See the interface in the new palette

status: implemented
requires: token, theme
anchors: apps/gateway/src/app/globals.css, apps/gateway/src/styles/tokens.css, apps/gateway/src/components/ui/Marks.tsx, apps/gateway/src/server/http/document.ts, apps/gateway/tests/unit/app/design-tokens.test.ts, packages/design-tokens/tests/unit/contrast.test.ts
spec: ../spec/style-guide.md#31-colour
acceptance:

- The interface's accent is `#2F55C7`; no orange or yellow remains in either theme
- The four rows read green, cool grey, mauve and deep plum, each a light pill with its word, and red appears only for refused, stopped or limit reached
- The contrast probe passes every documented pair in both themes

## Use the interface's components rebuilt on shared primitives

status: proposed
requires: component
spec: ../spec/style-guide.md#5-components
acceptance:

- Dialogs, menus, tabs, toasts and form controls of `components/ui` are built on the shared primitives, behind the same exports
- The `/design` gallery shows every component in every state in both themes, and its browser test passes
- Escape, focus trap and focus return behave as before in every dialog and menu
