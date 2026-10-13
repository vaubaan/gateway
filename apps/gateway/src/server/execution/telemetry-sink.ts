/**
 * The one hook community telemetry has in the call pipeline (spec §9).
 *
 * The upstream stage hands the sink the final outcome of every call that
 * reached `plugin.execute` — once per call, after the retry ladder, whatever
 * the outcome, except a call its caller abandoned (a disconnect is not an
 * outcome of the plugin). The sink is injected (`UpstreamStageDeps.telemetry`); the
 * default does nothing, so the pipeline has no dependency on the telemetry
 * module and behaves the same with or without it.
 *
 * Contract of an implementation:
 *
 *   - synchronous and non-blocking: it must not await the network;
 *   - it never throws (the stage also guards the call);
 *   - it reads the event and keeps nothing of it but what it derives for the
 *     report: the outcome carries the provider's result or error, which may
 *     echo the call's arguments. Reducing it to a closed vocabulary is the
 *     implementation's job (`server/telemetry/outcome.ts`).
 *
 * The event deliberately carries no mission, no connection, no resource and
 * no argument: the stage does not hand over what a report may never contain.
 */
import type { ProviderPlugin } from '@vaubaan/plugin-sdk';

/** What `plugin.execute` ended with: its result, or what was thrown at the end of the retries. */
export type PluginOutcome =
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly error: unknown };

export interface PluginExecution {
  /** The plugin that ran: its id, its version and the tools it declares. */
  readonly plugin: Pick<ProviderPlugin, 'id' | 'version' | 'tools'>;
  readonly tool: string;
  readonly outcome: PluginOutcome;
}

export interface TelemetrySink {
  pluginExecuted(execution: PluginExecution): void;
}

export const NOOP_TELEMETRY_SINK: TelemetrySink = {
  pluginExecuted(): void {
    // Telemetry is not wired: nothing is observed.
  },
};
