---
name: vaubaan-classify
description: Use after vaubaan-risk-catalog, to write src/classify.ts (pure, fail closed), its branch-by-branch tests and src/examples.ts, then prove every tool with npm run try. The gateway decides every call from what this file returns.
---

# Write the classifier

The same step for a person, with its reasons: https://vaubaan.com/docs/plugins-guide/classify (append `.md` to the path for Markdown). Read it when a rule below is unclear; this skill decides what you do and where you stop.

`classify(tool, args, resources)` returns `{ slices }` or `{ denied: '<sentence>' }`. `resources`
are the mission's resources. The gateway decides from the slices alone: a slice that understates a
call lets the call through. This is the file reviewers read line by line.

## Inputs

- `src/data-model.ts`, `src/tools.ts`, `src/risk-catalog.yaml` (done).
- The service's documentation of each endpoint the tools call, and where each argument lands
  (a URL path segment, a query, a JSON body, a GraphQL variable).

## Steps

1. **Resource first.** Keep the template's resolution function (in `src/classify.ts`): an explicit
   ref must be well-formed and one of the mission's resources of this service, else `denied`;
   absent, the mission's single resource; none or several, `denied`. Never substitute the single
   resource for a ref the caller named.
2. **One grammar function per kind of identifier**, returning the value or `null`, shared by
   `classify` and `execute`. Choose it for where the value lands:
   - a URL path segment: the template's `pathIdent` (`^[A-Za-z0-9_-]{1,64}$`): no `.` or `..`, no
     separator, no `%`;
   - a dotted or multi-segment value (a domain, a file path, a branch): a grammar of its own that
     forbids empty and dot-only segments, backslashes and control characters, and bounds the length;
   - a value your grammar accepts but a slice identifier cannot carry (a slice holds
     `[a-zA-Z0-9_./~-]` only; `@`, `:`, `+` do not fit): build that segment with
     `identSegment(value)` from `@vaubaan/plugin-sdk`, which gives `[*]` (every instance) for such a
     value, and assemble the `Slice` object (`{ service, path, action }`) instead of a string;
     send the value unchanged. Never write your own `[*]` or replace characters.

   A value outside its grammar is `denied`, never trimmed, escaped or read as absent. No `*` inside
   an identifier.
3. **One `case` per tool**, emitting exactly what the call touches, with `parseSlice`:
   - a list: `…<entity>[*].R`; one item: `…<entity>[<id>].R`; a creation: `…<entity>.W`; a change:
     `…<entity>[<id>].W`; a dangerous act: its verb leaf, `…<entity>[<id>].delete.W`;
   - several entities touched: several slices;
   - an effect that depends on an argument (a `force` flag, a query, a command): classify from that
     argument; refuse when you cannot read it;
   - anything that changes state, sends a message, or hands out a credential or a signed URL is a
     `W`. When the documentation leaves it unclear, stop and ask the human.

   The `default` branch stays a denial naming the unknown tool.
4. **Undeclared arguments.** If `execute` will forward `args` as they are (a JSON body or a query
   built from them), call `undeclaredArgumentDenial(declaredArgumentsOf(tools), tool, args)` from
   `@vaubaan/plugin-sdk` at the top of `classify`, and again in `execute`, through one exported
   function of your own. If `execute` builds each request field by field from declared arguments,
   no check is needed: say which in a comment.
5. **No IO.** No `fetch`, no `Date`, no credential, no file, no environment variable. Same input,
   same output.
6. **Examples.** Rewrite `src/examples.ts` with `samplesOn(<resources>, {...})`: at least one
   realistic sample per tool, none landing on the fallback, and the refusals worth showing with
   `expectDenied: true` (a resource outside the mission, an ambiguous resource).
7. **Tests.** Write `tests/unit/classify.test.ts`, one test per branch of `src/classify.ts`:
   - each tool's slices for a valid call (compare `serializeSlice` output with the exact string);
   - each refusal: unknown tool, resource outside the mission, resource of another service with the
     same ref, no resource or several, malformed and missing identifiers;
   - hostile identifiers in every identifier position: `..`, `.`, `a/b`, `a%2Fb`, `%2e%2e`, an empty
     string, a 65-character string, a number, `null`, a line break, `r1?x=1#y`;
   - for each layered write, the risks its slice touches: `risksTouchedBy(parseSlice(s),
     <catalog>.indexed)` from `@vaubaan/plugin-sdk/testing`;
   - the kit on the examples: `assertCatalogCoverage(plugin)` with `fallbackHits` and
     `risksUntouched` empty, and `assertSlicesOnDataModel(plugin, plugin.examples, { resources })`.
8. **Prove each tool with `npm run try`.** For every tool, with arguments of a real call:
   - a read: `npm run try -- <tool> '<args>' --accept <its read risk>` exits 0;
   - a write: `npm run try -- <tool> '<args>' --accept <every read risk>` must exit 1 (a write is
     not a read), and exits 0 once its write risks are accepted. An environment-scoped risk is
     accepted qualified, `<id>[staging].<name>`, with `--resources <ref>:staging`;
   - a hostile identifier: `npm run try -- <tool> '{"<arg>":".."}'` exits 1, denied by the classifier.

   Paste the output lines `slices`, `risks` and `decision` of each tool into your report.

## Stop for the human

When a tool's read or write nature, or the entity it touches, is not settled by the documentation,
show the human the tool, the endpoint and your two readings, and wait for their choice.

Done when: `npx vitest run tests/unit/classify.test.ts` exits 0.
