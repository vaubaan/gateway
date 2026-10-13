/**
 * Execution and resource discovery of the `ssh` provider.
 *
 * Spec : docs/spec/vaubaan-gateway.md §2.4, §5, §7.2.
 *
 * `execute` re-validates the arguments with the same function the classifier
 * used (`resolveExecArgs`), checks that the host named by the mission is the
 * host of the credential, then runs the command line through the transport.
 * `discoverResources` connects once — which verifies the pinned host key and
 * the key pair — runs `uname` to name the host, and returns the host as the
 * connection's single resource.
 *
 * No `ctx.fetch` here : the upstream is SSH, injected as an `SshTransport`
 * (`createSshRuntime({ transport })`) so tests never open a socket.
 */

import {
  type ConnectionContext,
  type ExecuteContext,
  type McpToolResult,
  type Resource,
} from '@vaubaan/plugin-sdk';

import { PROVIDER, resolveExecArgs } from './classify.ts';
import { sshTarget, type SshTarget } from './credential.ts';
import { DEFAULT_TIMEOUT_S, MAX_TIMEOUT_S, SSH_EXEC } from './tools.ts';
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
  discoverResources(ctx: ConnectionContext): Promise<readonly Resource[]>;
}

export function createSshRuntime(options: SshRuntimeOptions = {}): SshRuntime {
  const transport = options.transport ?? ssh2Transport;

  return {
    async execute(ctx, tool, args) {
      if (tool !== SSH_EXEC) return errorResult(`unknown tool '${tool}'`);
      const target = sshTarget(ctx.credential);
      const exec = resolveExecArgs(args, ctx.resources);
      if ('denied' in exec) return errorResult(exec.denied);
      if (exec.host !== target.host) {
        return errorResult(
          `host '${exec.host}' is not the host of this connection ('${target.host}')`,
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
    provider: PROVIDER,
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

function errorResult(message: string): McpToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

// ─── legacy v4, deleted in P1.6 ──────────────────────────────────────────────

/** @deprecated legacy v4, deleted in P1.6 — an `ssh_bindings` row as `exec-host.ts` loads it. */
export interface VpsSshBinding {
  host_address: string;
  port: number;
  ssh_user: string;
  ssh_private_key_pem: string;
}

/**
 * @deprecated legacy v4, deleted in P1.6 — use `sshPlugin.execute`. Runs over
 * the same transport **without a host key pin** (v4 stored none) ; the
 * transport logs a warning for every unpinned connection.
 */
export async function sshExec(
  binding: VpsSshBinding,
  cmd: string,
  timeout_s: number = DEFAULT_TIMEOUT_S,
): Promise<ExecResult> {
  const target: SshTarget = {
    host: binding.host_address,
    port: binding.port,
    user: binding.ssh_user,
    privateKeyPem: binding.ssh_private_key_pem,
    hostKeyFingerprint: null,
  };
  return ssh2Transport.exec(target, cmd, {
    timeoutMs: Math.min(timeout_s, MAX_TIMEOUT_S) * 1000,
  });
}
