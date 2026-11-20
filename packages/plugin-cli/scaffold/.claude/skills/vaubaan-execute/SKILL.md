---
name: vaubaan-execute
description: Use after vaubaan-credential, to write src/execute.ts, the calls to the service through the SDK's httpJson and discoverResources, with tests against mockFetch. Ends when the whole kit passes.
---

# Write the execution

The same step for a person, with its reasons: https://vaubaan.com/docs/plugins-guide/execute and https://vaubaan.com/docs/plugins-guide/test (append `.md` to the path for Markdown). Read it when a rule below is unclear; this skill decides what you do and where you stop.

`execute(ctx, tool, args)` performs a call the gateway already allowed and counted, and returns an
MCP result. `discoverResources(ctx)` lists what a credential reaches when an account is connected.
No test ever calls the real service.

## Inputs

- `src/classify.ts`: its resource resolution and grammar functions, reused here.
- The service's documentation of each endpoint: method, path, body, answer shape, pagination.

## Steps

1. **One way to call the service**: the `request` helper of `src/execute.ts`, which wraps
   `httpJson(ctx, { url, method, headers, body, what }, guard)` from `@vaubaan/plugin-sdk`. It takes
   `fetch` and the caller's `signal` from the context, bounds the answer, refuses redirects, reads
   the answer through `guard`, and throws every failure typed. Never call `ctx.fetch` or `fetch`
   directly, never `.json()` or `.text()` on a response. A body you must read yourself (a stream, a
   file) goes through `readBounded`, its failure through `upstreamFailure(response, what)`.
2. Take the secret with `expectCredentialKind(SERVICE_ID, ctx.credential, '<kind>')`. Never log it,
   never put it in a result or an error message.
3. **What is classified is what is sent.** At the top of `execute`, resolve the resource with the
   classifier's resolution function; read every identifier with the classifier's grammar functions
   and build the request from what they returned, never from `args` directly. If the classifier
   checks undeclared arguments, call the same function here.
4. **One `case` per tool**, mirroring `src/classify.ts`. Build a query with `URLSearchParams`, a
   body field by field from declared arguments. Return `jsonResult(payload)` or
   `textResult(text)`; a success without content (204) reads as `null` through the `anyJson` guard:
   return a confirmation of your own.
5. **Declining vs failing.**
   - What `execute` declines itself, before any request (an unknown tool, a malformed argument, a
     resource outside the mission): `return refusalResult('<sentence>')`, or, deeper in the code,
     `throw new ExecutorRefusal('<sentence>')` inside `declining(async () => …)`. Never a plain
     `Error`: it reads as a service failure.
   - A service failure is thrown, never caught into a result: the transport throws
     `UpstreamAuthError` (401, 403), `UpstreamHttpError` (other status), `UpstreamProtocolError` (an
     answer the guard refuses).
6. **Untrusted answers.** Read every answer through a type guard (`httpJson`'s third argument, or
   `readShape(value, guard, what)`), never a cast (`as SomeDto`). `anyJson` for an answer passed to
   the agent as it is.
7. **`discoverResources`**: call the service's list endpoint, read it through a guard, pass every
   id through the classifier's grammar (an id no call could name throws `UpstreamProtocolError`),
   and return `{ service: SERVICE_ID, ref, displayName }` per resource (`metadata` for non-secret
   facts the classifier needs). Follow pagination up to a named constant ceiling. Do not set `env`
   unless the service itself tells production from test.
8. Write `tests/unit/execute.test.ts`, every case against `mockFetch([...routes])` from
   `@vaubaan/plugin-sdk/testing`:
   - per tool: the request sent (method, URL, headers, body via `fetch.calls`) and the result;
   - a 401 rejected as `UpstreamAuthError`, a 503 as `UpstreamHttpError`;
   - each refusal: an `isError` result (`refusalText(execute(...))`) and `fetch.calls` empty;
   - hostile identifiers (`..`, `%2e%2e`, `a/b`, `%2f`) in every identifier position: no request;
   - `discoverResources`: the resources returned, a payload the guard refuses, an unusable id.
9. Keep the identifier proof of the structural kit (`assertIdentifiersRefused` in
   `tests/unit/plugin.test.ts`) and update its `pathIdentifiers` expectations to your tools and
   arguments. When no identifier travels in a URL path, pass `pathIdentifiers: { none: '<why>' }`.
10. Remove what is left of the imaginary service:
    `grep -rniE 'widget|workspace|example\.com' src tests` prints nothing (unless the real service
    has workspaces).
11. In `README.md`, fill the section "The plugin" for the real service: the data model, the
    credential and what one resource is, the tools, one line per risk, the macro-actions. State no
    version there: it lives in `package.json`.

Done when: `npm run check` exits 0.
