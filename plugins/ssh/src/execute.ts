/**
 * Execution and resource discovery of the `ssh` service.
 *
 * Spec : docs/spec/vaubaan-gateway.md §2.4, §5, §7.2.
 *
 * `execute` re-validates the arguments with the same function the classifier
 * used (`resolveExecArgs`), checks that the host named by the mission is the
 * host of the credential, then runs the command line through the transport.
 * `discoverResources` connects once — which verifies the pinned host key and
 * the key pair — runs `uname` to name the host, and returns the host as the
 * account's single resource.
 *
 * No `ctx.fetch` here : the upstream is SSH, injected as an `SshTransport`
 * (`createSshRuntime({ transport })`) so tests never open a socket.
 */

import {
  refusalResult,
  type AccountContext,
  type ExecuteContext,
  type McpToolResult,
  type Resource,
} from '@vaubaan/plugin-sdk';

import { resolveExecArgs } from './classify.ts';
import { sshTarget, type SshTarget } from './credential.ts';
import { SERVICE_ID, TOOL } from './identity.ts';
import { DEFAULT_TIMEOUT_S, MAX_TIMEOUT_S } from './tools.ts';
import { ssh2Transport, type ExecResult, type SshTransport } from './transport.ts';

/** Probe run at discovery : hostname, kernel, release, machine. POSIX. */
export const DISCOVERY_PROBE = 'uname -n -s -r -m';

export interface SshRuntimeOptions {
  /** Defaults to the real `ssh2` transport. */
  readonly transport?: SshTransport;
}

export interface SshRuntime {
  execute(
    ctx: ExecuteContext,
    tool: string,
    args: Readonly<Record<string, unknown>>,
  ): Promise<McpToolResult>;
  discoverResources(ctx: AccountContext): Promise<readonly Resource[]>;
}

export function createSshRuntime(options: SshRuntimeOptions = {}): SshRuntime {
  const transport = options.transport ?? ssh2Transport;

  return {
    async execute(ctx, tool, args) {
      // Declined before any connection : nothing failed at the host.
      if (tool !== TOOL.exec) return refusalResult(`unknown tool '${tool}'`);
      const target = sshTarget(ctx.credential);
      const exec = resolveExecArgs(args, ctx.resources);
      if ('denied' in exec) return refusalResult(exec.denied);
      if (exec.host !== target.host) {
        return refusalResult(
          `host '${exec.host}' is not the host of this account ('${target.host}')`,
        );
      }
      const timeoutS = Math.min(exec.timeoutS ?? DEFAULT_TIMEOUT_S, MAX_TIMEOUT_S);
      const result = await transport.exec(target, exec.cmd, {
        timeoutMs: timeoutS * 1000,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
        ...(ctx.logger ? { logger: ctx.logger } : {}),
      });
      return execResultToTool(result);
    },

    async discoverResources(ctx) {
      const target = sshTarget(ctx.credential);
      const probe = await transport.exec(target, DISCOVERY_PROBE, {
        timeoutMs: DEFAULT_TIMEOUT_S * 1000,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
        ...(ctx.logger ? { logger: ctx.logger } : {}),
      });
      return [hostResource(target, probe)];
    },
  };
}

/** The host as a `Resource` : ref = host, labelled later by the owner. */
export function hostResource(target: SshTarget, probe?: ExecResult): Resource {
  const uname = probe && probe.exit_code === 0 ? probe.stdout.trim() : '';
  const [hostname, kernel, release, machine] = uname.split(/\s+/);
  return {
    service: SERVICE_ID,
    ref: target.host,
    displayName: `${target.user}@${target.host}:${target.port}`,
    metadata: {
      user: target.user,
      port: target.port,
      host_key_fingerprint: target.hostKeyFingerprint,
      ...(hostname ? { hostname } : {}),
      ...(kernel && release ? { kernel: `${kernel} ${release}` } : {}),
      ...(machine ? { machine } : {}),
    },
  };
}

function execResultToTool(result: ExecResult): McpToolResult {
  const lines = [result.stdout];
  if (result.stderr) lines.push(`\n[stderr]\n${result.stderr}`);
  lines.push(
    `\n[exit ${result.exit_code} · ${result.duration_ms} ms${result.truncated ? ' · stdout truncated' : ''}]`,
  );
  return {
    content: [{ type: 'text', text: lines.join('') }],
    structuredContent: { ...result },
  };
}
