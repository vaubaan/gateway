<!-- Thank you for contributing. Keep the PR focused; one feature or fix per PR. -->

## What

<!-- One paragraph: what changes and why. Link the issue if there is one. -->

## Checklist

- [ ] **Spec**: does this change the _what_ or _why_ of a subsystem? If so, the matching `docs/spec/*.md` was updated first (or the gap is called out below).
- [ ] **ADR**: any non-trivial choice (library, public contract, structural refactor, rename of a domain entity) has an ADR under `docs/decisions/` with Context, Decision, Consequences and Rejected alternatives.
- [ ] **Handbook**: the handbook of every subsystem touched reflects the code as it is now, and its `tracks:` list covers the files changed.
- [ ] **Tests**: unit tests next to the code; new integration or e2e scenarios listed in `docs/tests/`.
- [ ] **English**: every new or modified file, comment and message is in English.
- [ ] **No hard-coded configuration**: no URL, project ref, secret or environment-specific value outside `deploy/config/*.example*`.
- [ ] **Local gate**: `npm run ci` is green (type-check, lint, format check, build, tests).
- [ ] **CHANGELOG**: an entry under `## [Unreleased]` when the change is user-visible.

## Notes for the reviewer

<!-- Anything you decided alone, left out on purpose, or want a second opinion on. -->
