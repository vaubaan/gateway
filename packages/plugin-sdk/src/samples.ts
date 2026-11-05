/**
 * Tool samples — representative calls of each tool, declared by the plugin
 * (`ProviderPlugin.examples`).
 *
 * ADR  : docs/decisions/plugin-contract-and-credential-spec.md, amendment
 *        2026-11-05 — the test kit reads them from the plugin instead of the
 *        test file, and the site runs `classify` on them when it builds.
 * Spec : docs/spec/gateway-risk-model.md §15 ("every tool has a sample call
 *        yielding slices its own catalog matches").
 */

import type { Resource } from '@vaubaan/shared';

/** One representative call of a tool. */
export interface SampleCall {
  readonly args: Readonly<Record<string, unknown>>;
  /** Mission resources for this sample ; defaults to the resources the caller passes. */
  readonly resources?: readonly Resource[];
  /** Set when the classifier itself is expected to refuse this sample. */
  readonly expectDenied?: boolean;
}

/** Sample calls keyed by tool name. Every tool of the plugin needs at least one. */
export type ToolSamples = Readonly<Record<string, readonly SampleCall[]>>;

/**
 * `samples` with `resources` set on every sample that names none : how a
 * plugin's `examples` carry the mission resources they run on, so a reader
 * without the plugin's test fixtures (the site's build) classifies them as
 * the tests do.
 */
export function samplesOn(resources: readonly Resource[], samples: ToolSamples): ToolSamples {
  return Object.fromEntries(
    Object.entries(samples).map(([tool, calls]) => [
      tool,
      calls.map((call) => (call.resources === undefined ? { ...call, resources } : call)),
    ]),
  );
}
