/**
 * The two hooks community telemetry has in the call pipeline (spec §9).
 *
 * `callDecided` (level `usage-stats`): every call the pipeline audited hands
 * the sink what the gateway decided — the tool, the decision, the risks
 * touched and whether an approval was consumed — through the audit writer of
 * the stages (`withDecisionTelemetry`), so the execution door and the git
 * remote report alike. Nothing else of the audit entry is passed on.
 *
 * `pluginExecuted` (level `plugin-health`): the upstream stage hands the sink the final outcome of every call that
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
import type { AuditEntry, AuditWriter } from '@vaubaan/gateway-core';
import type { ProviderPlugin } from '@vaubaan/plugin-sdk';
import type { RefusalCode, RiskId } from '@vaubaan/shared';

/** What `plugin.execute` ended with: its result, or what was thrown at the end of the retries. */
export type PluginOutcome =
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly error: unknown };

export interface PluginExecution {
  /** The plugin that ran: its id, its version and the tools it declares. */
  readonly plugin: Pick<ProviderPlugin, 'id' | 'version' | 'tools'>;
  readonly tool: string;
  readonly outcome: PluginOutcome;
  /** From the first `execute` to the final outcome, retries included. Bucketed before it leaves. */
  readonly durationMs: number;
}

/** What the gateway decided about one call: the four facts a decision report is built from. */
export interface CallDecision {
  readonly tool: string;
  /** `allowed`, the refusal code, or `null` for a refusal without a code (unknown tool, classifier denial). */
  readonly decision: 'allowed' | RefusalCode | null;
  /** As the audit holds them: environment-qualified ids keep their qualifier here; the report drops it. */
  readonly risksTouched: readonly RiskId[];
  /** The call consumed an approval, or was refused for want of one. */
  readonly gated: boolean;
}

export interface TelemetrySink {
  pluginExecuted(execution: PluginExecution): void;
  callDecided(decision: CallDecision): void;
}

export const NOOP_TELEMETRY_SINK: TelemetrySink = {
  pluginExecuted(): void {
    // Telemetry is not wired: nothing is observed.
  },
  callDecided(): void {
    // Telemetry is not wired: nothing is observed.
  },
};

/**
 * The stages' audit writer, telling the sink about each call entry once it is
 * written. A sink never fails the write, and the entry it is handed is reduced
 * to a `CallDecision` first: no mission, token, holder, resource or hash.
 */
export function withDecisionTelemetry(
  audit: AuditWriter,
  sink: TelemetrySink,
  onSinkError: (error: unknown) => void,
): AuditWriter {
  return {
    async write(entry: AuditEntry): Promise<void> {
      await audit.write(entry);
      if (entry.kind !== 'call') return;
      try {
        sink.callDecided({
          tool: entry.tool,
          decision: entry.decision === 'allowed' ? 'allowed' : entry.refusal_code,
          risksTouched: entry.risks_touched,
          gated: entry.approval_id !== null || entry.refusal_code === 'approval-required',
        });
      } catch (error) {
        onSinkError(error);
      }
    },
  };
}
