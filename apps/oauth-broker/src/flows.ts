/**
 * Flows in progress, in memory only (spec oauth-broker §3). A flow lives ten
 * minutes from its start; the grant it issues lives five minutes, never past
 * the flow. Nothing survives a restart, by design: a restart only costs the
 * people in the middle of a sign-in a new attempt.
 */
import { randomToken } from './crypto-util.ts';

export interface FlowStart {
  readonly instanceId: string;
  readonly provider: string;
  readonly scopes: readonly string[];
  readonly returnUrl: string;
  /** The gateway's state, given back unchanged. */
  readonly gatewayState: string;
  /** The gateway's PKCE challenge, checked at redeem. */
  readonly gatewayChallenge: string;
}

export interface Flow extends FlowStart {
  /** Also the `state` sent to the provider. */
  readonly id: string;
  /** The broker's own PKCE verifier toward the provider (ADR D6). */
  readonly brokerVerifier: string;
  readonly startedAt: number;
  /** The provider's code, unexchanged until the redeem. */
  code?: string;
  grant?: string;
  grantIssuedAt?: number;
}

export interface FlowStoreOptions {
  readonly now?: () => number;
  readonly flowTtlMs?: number;
  readonly grantTtlMs?: number;
  /** All instances together. */
  readonly maxFlows?: number;
  /** One instance, so that one cannot take the whole store. */
  readonly maxFlowsPerInstance?: number;
}

/** A new flow, or which cap refused it. */
export type StartResult = { flow: Flow } | { full: 'instance' | 'broker' };

export class FlowStore {
  readonly #flows = new Map<string, Flow>();
  readonly #byGrant = new Map<string, string>();
  readonly #now: () => number;
  readonly #flowTtlMs: number;
  readonly #grantTtlMs: number;
  readonly #maxFlows: number;
  readonly #maxPerInstance: number;
  readonly #perInstance = new Map<string, number>();

  constructor(options: FlowStoreOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#flowTtlMs = options.flowTtlMs ?? 10 * 60_000;
    this.#grantTtlMs = options.grantTtlMs ?? 5 * 60_000;
    this.#maxFlows = options.maxFlows ?? 10_000;
    this.#maxPerInstance = options.maxFlowsPerInstance ?? 500;
  }

  get size(): number {
    return this.#flows.size;
  }

  start(fields: FlowStart): StartResult {
    this.sweep();
    if ((this.#perInstance.get(fields.instanceId) ?? 0) >= this.#maxPerInstance) {
      return { full: 'instance' };
    }
    if (this.#flows.size >= this.#maxFlows) return { full: 'broker' };
    const flow: Flow = {
      ...fields,
      id: randomToken(),
      brokerVerifier: randomToken(),
      startedAt: this.#now(),
    };
    this.#flows.set(flow.id, flow);
    this.#perInstance.set(flow.instanceId, (this.#perInstance.get(flow.instanceId) ?? 0) + 1);
    return { flow };
  }

  /** A live flow still waiting for the provider's answer. */
  awaitingCallback(id: string): Flow | undefined {
    const flow = this.#flows.get(id);
    if (flow === undefined || this.#expired(flow) || flow.code !== undefined) return undefined;
    return flow;
  }

  /** Keeps the code in the flow and answers the one-time grant for it. */
  issueGrant(flow: Flow, code: string): string {
    const grant = randomToken();
    flow.code = code;
    flow.grant = grant;
    flow.grantIssuedAt = this.#now();
    this.#byGrant.set(grant, flow.id);
    return grant;
  }

  /**
   * Removes and answers the flow of a grant. A grant is spent by its first
   * redeem attempt, whatever follows; an expired one answers undefined.
   */
  takeByGrant(grant: string): Flow | undefined {
    const id = this.#byGrant.get(grant);
    if (id === undefined) return undefined;
    const flow = this.#flows.get(id);
    this.#byGrant.delete(grant);
    if (flow === undefined) return undefined;
    this.end(flow);
    return this.#expired(flow) ? undefined : flow;
  }

  end(flow: Flow): void {
    if (!this.#flows.delete(flow.id)) return;
    if (flow.grant !== undefined) this.#byGrant.delete(flow.grant);
    const left = (this.#perInstance.get(flow.instanceId) ?? 1) - 1;
    if (left > 0) this.#perInstance.set(flow.instanceId, left);
    else this.#perInstance.delete(flow.instanceId);
  }

  sweep(): void {
    for (const flow of this.#flows.values()) {
      if (this.#expired(flow)) this.end(flow);
    }
  }

  #expired(flow: Flow): boolean {
    const now = this.#now();
    if (now - flow.startedAt >= this.#flowTtlMs) return true;
    return flow.grantIssuedAt !== undefined && now - flow.grantIssuedAt >= this.#grantTtlMs;
  }
}
