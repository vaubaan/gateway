---
title: Recognise Vaubaan at a glance
status: proposed
actors: [user]
spec: ../spec/style-guide.md
last_reviewed: 2026-11-20
---

# Recognise Vaubaan at a glance

As a person moving between the site and my instance, I want one mark, one accent and the same parts
everywhere, so that I recognise Vaubaan and read a risk or a refusal the same way on every page.

## Read the site in the Trace identity

status: proposed
requires: token, component
spec: ../spec/style-guide.md#3-tokens
acceptance:

- The site shows the Trace mark, its favicon and social card, and uses the accent `#2F55C7` alone
- Its pages are built from the shared token sheet and components, in light and dark
- The site's contrast pairs are checked by the same test as the interface's

## See the interface in the new palette

status: proposed
requires: token, theme
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
