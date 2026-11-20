---
name: vaubaan-model-service
description: Use first, when the project still describes the imaginary widgets service. Reads the real service's API documentation, chooses the resource and the entities, writes src/data-model.ts, the tool names in src/identity.ts and the tools in src/tools.ts.
---

# Model the service

The same step for a person, with its reasons: https://vaubaan.com/docs/plugins-guide/model-a-service (append `.md` to the path for Markdown). Read it when a rule below is unclear; this skill decides what you do and where you stop.

You replace the imaginary service (workspaces holding widgets) with the real one: what one resource
is, which entities a call can touch, which tools the plugin offers. No classification yet, no
credential, no call to the service.

## Inputs

Ask the human for what you do not have:

- the service and the link to its API documentation;
- what agents will do with it (the use case): it bounds which tools are worth offering;
- the tools they want, if they already know.

The plugin's id is fixed: `SERVICE_ID` in `src/identity.ts`. Do not change it.

## Steps

1. Read the service's API documentation from its source (the official reference, or a docs tool
   such as Context7). Never from memory. Note the pages and the date: they go in a comment at the
   top of `src/data-model.ts` and `src/tools.ts`.
2. Choose the **resource**: the thing a mission is limited to and an account lists (a project, a
   zone, a workspace, a repository). It is the root entity of the model and what
   `discoverResources` will return. Use the service's stable id for it, never a name that can
   change.
3. Decide where a call's **environment** comes from:
   - the owner labels each resource `staging` / `prod` → mark the root entity `envScopable: true`
     (the common case);
   - the environment is part of the call (an `env` argument, a live and a test mode) → an entity for
     it in the model, and `envOf: envFromSliceSegment('<entity>')` in `src/index.ts`;
   - the service has no notion of environment → neither.
4. List the entities below the resource, each with its `parent` and `cardinalities`: `one` (one
   id, or none: a creation), `bounded` (an explicit list), `unbounded` (`[*]`, all of them: a list
   call). One **plane** per independent area of the service; most services have one.
5. Give each operation that deserves its own decision among the writes a **verb leaf**: an entity
   under the one it acts on (`{ name: 'delete', parent: 'widget', cardinalities: ['one'] }`), so
   the slice `…widget[w-7].delete.W` can carry its own risk. Typical: delete, publish, transfer,
   invite, share, rotate.
6. Write `src/data-model.ts` (keep its shape: `service: SERVICE_ID`, `planes`, `entities`).
7. Choose the tools: the operations the use case needs, not the whole API. One tool per operation,
   named `<verb>_<noun>` (`list_projects`, `delete_record`). Write them in `TOOL` in
   `src/identity.ts`, built with the prefix already there. Every tool that acts on a resource takes
   the resource's ref as an explicit argument.
8. Write `src/tools.ts`: for each tool a description an agent reads, an `inputSchema` whose
   `properties` are the whole argument surface (an argument not declared there is never used), the
   `required` list, and a short title in the titles table (a verb and its object, sentence case,
   no final period, 60 characters at most). A tool of the service left out on purpose and worth
   explaining goes in `excludedTools` in `src/index.ts`, one sentence.
9. In `src/index.ts` set `displayName`, `description`, `summary` (≤ 600 characters: what one
   account is, what one resource is, where the environment comes from), `resourceNoun`
   (`{ one: 'project', other: 'projects' }`) and `manualRevocation`. In `src/icon.ts` put the
   service's mark (a Simple Icons path, CC0, naming the slug in the comment, or one drawn on a
   24×24 grid) and its colour. In `src/execute.ts` set the API base URL constant to the real one.
10. Make the project compile without the imaginary service's tool names. Later skills rewrite each
    of these files; here they only need to type-check and stay fail-closed:
    - `src/classify.ts`: remove the widget cases; keep the resource resolution and the `default`
      branch that returns `{ denied }`, so every call is refused for now.
    - `src/execute.ts`: remove the widget cases; keep the `default` branch that returns
      `refusalResult(...)`.
    - `src/examples.ts`: one sample per new tool, with your best guess of its arguments.
    - `src/credential.ts`: the permissions table lists every new tool under some permission
      (provisional; `vaubaan-credential` rewrites it).
    - `tests/unit/plugin.test.ts`: keep the `… plugin — structural kit` block and replace the
      widget tool names it uses with new ones; delete the `classify…` and `execute… with
      mockFetch` blocks (they test widgets; `vaubaan-classify` and `vaubaan-execute` write their
      replacements in `tests/unit/classify.test.ts` and `tests/unit/execute.test.ts`). The original
      template, tests included, stays readable under `node_modules/@vaubaan/plugin-cli/template/`.
11. List what is left of the imaginary service: `grep -rniE 'widget|workspace|example\.com' src tests`.
    Each remaining hit belongs to a later skill; say which in your report.

## Stop for the human

Before step 6, show the human the resource, the environment choice, the entity tree and the tool
list in a few lines, and ask whether it matches what their agents will do. Write the files once
they agree.

## Report

The documentation pages used, the model as a tree, the tools with their arguments, the operations
left out and why.

`npm run check` is expected to fail until `vaubaan-execute` is done; the type check must pass now.

Done when: `npx tsc --noEmit` exits 0.
