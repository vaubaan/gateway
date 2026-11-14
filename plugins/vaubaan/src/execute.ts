/**
 * Execution of the `vaubaan` provider.
 *
 * ADR      : docs/decisions/platform-management-is-a-plugin-on-the-execution-door.md.
 * Handbook : docs/handbook/providers/vaubaan.md.
 *
 * The plugin's own `execute` refuses every call: the tools act on the gateway's
 * own services, which only the host can hand over. The host composes the real
 * one with `createVaubaanExecute(ports)` and calls it with the caller added to
 * the context (`VaubaanExecuteContext`); no IO leaves the process.
 *
 * An answer is **structured content**, also serialized as text for clients that
 * only read text. A "no" — a draft beyond the user's authority, a mission that is
 * not theirs, an act on the calling mission itself — is a tool error
 * (`isError`) whose structured content is `{ error: { code, message, hint, … } }`,
 * so the model reads it and corrects itself. A port that throws answers
 * `internal-error`, whose message never carries the details.
 */

import type { McpToolResult, Resource } from '@vaubaan/plugin-sdk';

import { actOf, PROVIDER_ID } from './identity.ts';
import type { VaubaanAnswer, VaubaanHostExecute, VaubaanPorts } from './ports.ts';

/** Thrown by the plugin's own `execute`: only the host that composed it runs a call. */
export class HostOnlyPluginError extends Error {
  constructor() {
    super(
      `${PROVIDER_ID}: this plugin runs only inside the gateway that composed it (createVaubaanExecute)`,
    );
    this.name = 'HostOnlyPluginError';
  }
}

/** The plugin's declared `execute`: never the one a call runs through. */
export async function executeOutsideTheHost(): Promise<McpToolResult> {
  throw new HostOnlyPluginError();
}

/** A Vaubaan account lists no resource: the account itself is what a mission reaches. */
export async function discoverVaubaanResources(): Promise<readonly Resource[]> {
  return [];
}

/** An answer as MCP carries it: structured content, and the same as text. */
export function toolResultOf(answer: VaubaanAnswer): McpToolResult {
  if (answer.ok) {
    return {
      content: [{ type: 'text', text: JSON.stringify(answer.data, null, 2) }],
      structuredContent: answer.data as Readonly<Record<string, unknown>>,
    };
  }
  const { refusal } = answer;
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: `${refusal.code}: ${refusal.message} ${refusal.hint}\n${JSON.stringify({ error: refusal }, null, 2)}`,
      },
    ],
    structuredContent: { error: refusal },
  };
}

/** What a port that threw answers: nothing of the cause, what to do. */
export const INTERNAL_ERROR_RESULT: McpToolResult = {
  isError: true,
  content: [
    {
      type: 'text',
      text: 'internal-error: the gateway could not complete this call. Nothing can be assumed about its effect: read the state again with `vaubaan__list_my_missions` before retrying.',
    },
  ],
  structuredContent: {
    error: {
      code: 'internal-error',
      message: 'The gateway could not complete this call.',
      hint: 'Read the state again with `vaubaan__list_my_missions` before retrying.',
    },
  },
};

/**
 * The `execute` the host runs: the tool's act, called with the caller and the
 * arguments. An unknown tool throws (the classifier refused it before).
 * Arguments and answers are never logged: an answer may carry a mission key.
 */
export function createVaubaanExecute(ports: VaubaanPorts): VaubaanHostExecute {
  return async (ctx, tool, args) => {
    const act = actOf(tool);
    if (act === null) throw new Error(`${PROVIDER_ID}: unknown tool '${tool}'`);
    try {
      // nosemgrep: unsafe-dynamic-method -- `act` is a key of the closed `ACT` table (`actOf` answers `null` for any other name, refused above), and `ports` is a frozen object of exactly those seven functions (`VAUBAAN_PORT_NAMES`)
      return toolResultOf(await ports[act](ctx.caller, args));
    } catch (err) {
      ctx.logger?.error('vaubaan tool failed', {
        tool,
        mission_id: ctx.caller.missionId,
        error: err instanceof Error ? err.name : typeof err,
      });
      return INTERNAL_ERROR_RESULT;
    }
  };
}
