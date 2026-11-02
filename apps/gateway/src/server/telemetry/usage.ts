/**
 * The `usage-stats` level (spec §9; ADR telemetry-two-levels-behind-a-vercel-collector):
 * the decision report of each audited call, and the instance profile of each
 * UTC day. Both are built here from facts the gateway already holds, and
 * vetted by the constructors of `@vaubaan/telemetry`, which drop anything that
 * does not fit.
 *
 * The instance identifier (`instance-id.ts`) is put on the profile and
 * nowhere else: it counts the gateways running a plugin version over the
 * collector's window, and never joins a profile to a call.
 */
import { existsSync } from 'node:fs';

import type { PluginRegistry } from '@vaubaan/plugin-sdk';
import { baseRiskId, isRiskId } from '@vaubaan/shared/risk-id';
import {
  countBucket,
  createDecisionReport,
  createInstanceProfile,
  type DecisionReport,
  type DeploymentKind,
  type InstanceProfile,
  type SignInKind,
} from '@vaubaan/telemetry';

import { FLY_APP_ENV, RAILWAY_PROJECT_ENV } from '../config/self-resources';
import type { CallDecision } from '../execution/telemetry-sink';

type Registry = Pick<PluginRegistry, 'ids' | 'get'>;

/** The tool prefix of a plugin: its id with `-` written `_` (`cloudflare-dns` → `cloudflare_dns__`). */
function toolPrefixOf(pluginId: string): string {
  return `${pluginId.replace(/-/g, '_')}__`;
}

/** The registered plugin a tool name belongs to, by the plugin's declaration or its prefix. */
function pluginOfTool(registry: Registry, tool: string) {
  for (const id of registry.ids) {
    const plugin = registry.get(id)?.plugin;
    if (!plugin) continue;
    if (plugin.tools.some((declared) => declared.name === tool)) return { plugin, declared: true };
  }
  for (const id of registry.ids) {
    const plugin = registry.get(id)?.plugin;
    if (plugin && tool.startsWith(toolPrefixOf(plugin.id))) return { plugin, declared: false };
  }
  return null;
}

/**
 * The decision report of one call, or `null` when it must not be reported: a
 * refusal without a code, a tool of no registered plugin, a value that does
 * not fit. The tool name travels only if the plugin declares it.
 */
export function decisionReportOf(
  decision: CallDecision,
  registry: Registry,
  gatewayVersion: string,
): DecisionReport | null {
  if (decision.decision === null || decision.decision === 'wrong-credential-kind') return null;
  const found = pluginOfTool(registry, decision.tool);
  if (!found) return null;
  const risks = decision.risksTouched.filter(isRiskId).map((risk) => baseRiskId(risk));
  return createDecisionReport({
    plugin: found.plugin.id,
    tool: found.declared ? decision.tool : null,
    gateway_version: gatewayVersion,
    decision: decision.decision,
    risks,
    gate: decision.gated ? 'approval' : 'none',
  });
}

/** What the store tells the profile: counts only, never a name. */
export interface ProfileSource {
  users(): Promise<number>;
  activeMissions(now: Date): Promise<number>;
  /** Accounts per provider id. */
  accountsByProvider(): Promise<Readonly<Record<string, number>>>;
}

export interface InstanceProfilerDeps {
  readonly registry: Registry;
  readonly gatewayVersion: string;
  readonly signInKinds: readonly SignInKind[];
  readonly source: ProfileSource;
  /** The stored instance identifier, drawn on first use (`InstanceIdentifier.current`). */
  readonly instanceId: () => Promise<string>;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** `/.dockerenv` exists (tests). */
  readonly inDocker?: () => boolean;
}

/** Where the instance runs, from what the platform sets in the environment. */
export function deploymentKindOf(
  env: Readonly<Record<string, string | undefined>>,
  inDocker: () => boolean,
): DeploymentKind {
  if (env[RAILWAY_PROJECT_ENV]?.trim()) return 'railway';
  if (env[FLY_APP_ENV]?.trim()) return 'fly';
  return inDocker() ? 'docker' : 'other';
}

function archOf(arch: string): 'x64' | 'arm64' | 'other' {
  return arch === 'x64' || arch === 'arm64' ? arch : 'other';
}

/** The UTC day of an instant, `YYYY-MM-DD`. */
export function utcDayOf(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export class InstanceProfiler {
  // single-process only: the count of calls since the last profile lives in
  // this process's memory. Replicas share the stored identifier, so the
  // collector counts the deployment once; each replica's profile carries the
  // calls it decided itself.
  private calls = 0;

  constructor(private readonly deps: InstanceProfilerDeps) {}

  /** One more call decided since the last profile. */
  countCall(): void {
    this.calls += 1;
  }

  /** The profile of `now`; the call counter starts again from zero. */
  async profile(now: Date): Promise<InstanceProfile | null> {
    const { registry, source } = this.deps;
    const [users, missions, accounts, instanceId] = await Promise.all([
      source.users(),
      source.activeMissions(now),
      source.accountsByProvider(),
      this.deps.instanceId(),
    ]);
    const calls = this.calls;
    this.calls = 0;
    const plugins = registry.ids.flatMap((id) => {
      const plugin = registry.get(id)?.plugin;
      return plugin
        ? [
            {
              plugin: plugin.id,
              plugin_version: plugin.version,
              accounts: countBucket(accounts[plugin.id] ?? 0),
            },
          ]
        : [];
    });
    return createInstanceProfile({
      instance_id: instanceId,
      gateway_version: this.deps.gatewayVersion,
      deployment: deploymentKindOf(
        this.deps.env ?? process.env,
        this.deps.inDocker ?? (() => existsSync('/.dockerenv')),
      ),
      runtime: `node-${process.versions.node.split('.')[0] ?? '0'}`,
      arch: archOf(process.arch),
      sign_in_kinds: this.deps.signInKinds,
      users: countBucket(users),
      active_missions: countBucket(missions),
      calls: countBucket(calls),
      plugins,
    });
  }
}
