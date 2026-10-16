/**
 * The rig of the management-door tests (spec §10 "OAuth delegation then
 * issuance of a mission by an MCP client within the user's authority and
 * refusal beyond it"): the authorization-server instance (real composition
 * root on the `:memory:` store, simulated IdP, the instance's HTTP surface as
 * one `fetch`), Ada's seeded connections on the shipped plugins, and an
 * **agent** — the official MCP client holding a delegated token obtained
 * through the real OAuth flow.
 */
import { Client, ProtocolError, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { AdminAuditEntry } from '@vaubaan/gateway-core';

import type { Actor } from '../../../src/server/connections';
import type { UserRecord } from '../../../src/server/store/types';
import { seedInstance, type SeededInstance } from '../missions/support';
import {
  ADA,
  BOB,
  delegate,
  EXECUTION_URL,
  MANAGEMENT_URL,
  openInstance,
  type Delegated,
  type Instance,
  type InstanceOptions,
} from '../oauth-as/support';

export { ADA, BOB, EXECUTION_URL, MANAGEMENT_URL };

/** What a tool answered: its structured content, and whether it is a refusal. */
export interface ToolAnswer<T = Record<string, unknown>> {
  readonly isError: boolean;
  /** True when the door rejected the call itself (unknown tool) rather than a tool answering no. */
  readonly protocolError: boolean;
  readonly data: T;
  /** The text content, as a text-only client reads it. */
  readonly text: string;
}

export interface Agent {
  readonly delegated: Delegated;
  readonly client: Client;
  toolNames(): Promise<string[]>;
  call<T = Record<string, unknown>>(
    name: string,
    args?: Record<string, unknown>,
  ): Promise<ToolAnswer<T>>;
  close(): Promise<void>;
}

export interface ManagementRig extends Instance {
  readonly seeded: SeededInstance;
  /** A user with their current groups, as a page builds it (for sharing). */
  actor(user: UserRecord): Promise<Actor>;
  /** Registration, sign-in, consent, code exchange, then an MCP client on `/mcp/manage`. */
  agentOf(claims?: Record<string, unknown>): Promise<Agent>;
  adminEntries(act: AdminAuditEntry['act']): Promise<AdminAuditEntry[]>;
}

export async function connectWithToken(instance: Instance, url: string, token: string) {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    fetch: instance.fetch,
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'scripted-agent', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

export async function openManagementRig(options: InstanceOptions = {}): Promise<ManagementRig> {
  const instance = await openInstance(options);
  const seeded = await seedInstance(instance.root);
  const { root } = instance;

  const rig: ManagementRig = {
    ...instance,
    seeded,
    async actor(user) {
      return { user, groups: await root.store.groups.groupsOf(user.id) };
    },
    async agentOf(claims = ADA) {
      const delegated = await delegate(instance, claims);
      const client = await connectWithToken(
        instance,
        MANAGEMENT_URL,
        delegated.tokens.access_token,
      );
      return {
        delegated,
        client,
        async toolNames() {
          return (await client.listTools()).tools.map((tool) => tool.name);
        },
        async call<T>(name: string, args: Record<string, unknown> = {}) {
          let result: Awaited<ReturnType<Client['callTool']>>;
          try {
            result = await client.callTool({ name, arguments: args });
          } catch (err) {
            // A tool that does not exist is a protocol error, not a tool answer.
            if (!(err instanceof ProtocolError)) throw err;
            return { isError: true, protocolError: true, data: {} as T, text: err.message };
          }
          const content = (result.content ?? []) as { type: string; text?: string }[];
          return {
            isError: result.isError === true,
            protocolError: false,
            data: (result.structuredContent ?? {}) as T,
            text: content.map((part) => part.text ?? '').join(''),
          };
        },
        close: () => client.close(),
      };
    },
    async adminEntries(act) {
      const entries = await root.store.audit.list({ kind: 'admin' });
      return entries.filter(
        (e): e is typeof e & AdminAuditEntry => e.kind === 'admin' && e.act === act,
      );
    },
  };
  return rig;
}

/** A draft on one connection with explicit risks, each with its budget. */
export function draftOn(
  connectionId: string,
  riskIds: readonly string[],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    name: 'Fix the flaky test',
    connections: [
      {
        connection_id: connectionId,
        resources: { scope: 'all' },
        policy: riskIds.map((risk_id) => ({
          risk_id,
          quota: 20,
          rate_limit: { max: 5, window_seconds: 60 },
          gate: 'auto',
        })),
      },
    ],
    period: { kind: 'recurring', length_seconds: 86_400 },
    expires_at: null,
    ...overrides,
  };
}
