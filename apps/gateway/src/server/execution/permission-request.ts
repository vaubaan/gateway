import { z } from 'zod';
import type { CallToolResult, ListToolsResult } from '@modelcontextprotocol/server';
import type { MissionContext } from '@vaubaan/gateway-core';
import type { Store } from '../store';
import type { InstanceConfig } from '../config';
import type { Clock } from '../store/clock';
import { requestUrl } from '../requests/url';
import { effectiveState } from '../requests/state';

export const permissionRequestTool: ListToolsResult['tools'][number] = {
  name: 'vaubaan__request_permission',
  description:
    'Deliberately ask the mission creator for missing permissions after a risk-not-accepted refusal, only when the assigned task requires them. Explain why, then give the returned URL to the human. This never grants permission or runs the refused call. Reuse the same refusal_id to read the answer.',
  inputSchema: {
    type: 'object',
    properties: {
      refusal_id: { type: 'string' },
      reason: { type: 'string', minLength: 1, maxLength: 1000 },
    },
    required: ['refusal_id', 'reason'],
    additionalProperties: false,
  },
};
const schema = z
  .object({ refusal_id: z.string().min(1).max(300), reason: z.string().trim().min(1).max(1000) })
  .strict();
const result = (body: object, isError = false): CallToolResult => ({
  ...(isError ? { isError: true } : {}),
  content: [{ type: 'text', text: JSON.stringify(body) }],
});
export async function requestPermission(
  store: Store,
  config: Pick<InstanceConfig, 'publicUrl' | 'requests'>,
  ctx: MissionContext,
  raw: unknown,
  clock: Clock,
): Promise<CallToolResult> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success)
    return result(
      {
        error: 'invalid-request',
        message: 'Provide refusal_id and a reason of 1–1000 characters.',
      },
      true,
    );
  const asked = await store.requests.askPermission({
    refusalId: parsed.data.refusal_id,
    missionId: ctx.mission.id,
    tokenId: ctx.token.id,
    reason: parsed.data.reason,
    expirySeconds: config.requests.expirySeconds,
  });
  if (!asked.ok) return result({ error: asked.reason }, true);
  const request = await store.requests.getById(asked.requestId);
  if (!request) return result({ error: 'invalid-refusal' }, true);
  if (asked.created)
    await store.auditWriter.write({
      kind: 'admin',
      ts: clock.now().toISOString(),
      user_id:
        ctx.token.holder.kind === 'member' ? ctx.token.holder.user_id : ctx.mission.creator_id,
      act: 'permission-requested',
      object: { type: 'request', id: request.id },
      before: null,
      after: {
        mission_id: ctx.mission.id,
        token_id: ctx.token.id,
        requested_by_agent: true,
        risk_ids: request.riskIds,
        tool: request.tool,
      },
      delegated_client_id: null,
    });
  return result({
    request_id: request.id,
    state: effectiveState(request, clock.now()),
    request_url: requestUrl(config.publicUrl, request.id),
    expires_at: request.expiresAt,
    hint: 'Give this URL to the mission creator. A grant changes the mission; retry the original call only after their answer.',
  });
}
