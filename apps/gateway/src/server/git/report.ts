/**
 * The answer git reads after a push (spec §4.1 ter; ADR gateway-as-git-remote
 * D7): the report-status git turns into `* [new branch]` and
 * `! [remote rejected] <ref> (<reason>)`, one line per ref, and the
 * gateway's messages on the progress channel (`remote: Vaubaan: …`).
 */
import type { CallOutcome, Refusal } from '@vaubaan/gateway-core';
import type { GitPushResult, RefCommand } from '@vaubaan/plugin-sdk';

import { firstLine } from './temporary-refs';
import { pushReport, type RefOutcome, type ReportFormat } from './wire';
import { prefixed, refusalLine, refusalText, resultText } from './words';

/** The same reason on every ref of the push: one refused ref refuses them all. */
export function refuseAll(
  format: ReportFormat,
  commands: readonly RefCommand[],
  reason: string,
  messages: string = prefixed(reason),
): Response {
  return pushReport({
    format,
    unpack: 'ok',
    refs: commands.map((c) => ({ ref: c.ref, error: reason })),
    messages,
  });
}

/** The report of a decided push, from its outcome. */
export function reportOf(
  outcome: CallOutcome,
  commands: readonly RefCommand[],
  format: ReportFormat,
  provider: string,
): Response {
  switch (outcome.kind) {
    case 'refused':
      return refuseAll(format, commands, refusalLine(outcome.refusal), messagesOf(outcome.refusal));
    case 'rejected':
      return refuseAll(format, commands, outcome.reason);
    case 'failed': {
      if (outcome.refusal) {
        return refuseAll(
          format,
          commands,
          refusalLine(outcome.refusal),
          messagesOf(outcome.refusal),
        );
      }
      return refuseAll(
        format,
        commands,
        `${provider} refused the update: ${firstLine(outcome.error)}`,
      );
    }
    case 'allowed':
      return pushReport({ format, unpack: 'ok', refs: refOutcomes(outcome.result, commands) });
  }
}

/** The messages of a refusal on the progress channel. */
export function messagesOf(refusal: Refusal): string {
  if (refusal.code === 'approval-required') {
    return prefixed(
      [
        "This push needs the approval of the mission's creator. Nothing was pushed.",
        `Hand this URL to your human: ${refusal.approval_url}`,
        `Once approved, push the same commits again within ${refusal.approval_valid_seconds} s; a changed commit asks again.`,
      ].join('\n'),
    );
  }
  return refusalText(refusal);
}

/** Per-ref outcome of the push tool's result (`GitPushResult` in its text). */
export function refOutcomes(result: unknown, commands: readonly RefCommand[]): RefOutcome[] {
  const text = resultText(result);
  let parsed: GitPushResult | null = null;
  try {
    const value: unknown = JSON.parse(text);
    if (
      typeof value === 'object' &&
      value !== null &&
      Array.isArray((value as GitPushResult).updates)
    ) {
      parsed = value as GitPushResult;
    }
  } catch {
    parsed = null;
  }
  return commands.map((c) => {
    if (!parsed) return { ref: c.ref, error: firstLine(text) || 'the update was not applied' };
    const u = parsed.updates.find((x) => x.ref === c.ref);
    if (!u) return { ref: c.ref, error: 'no status reported' };
    return { ref: c.ref, error: u.ok ? null : (u.error ?? 'rejected') };
  });
}
