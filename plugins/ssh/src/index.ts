/**
 * `@vaubaan/plugin-ssh` — bash over SSH as a Vaubaan Gateway provider plugin.
 *
 * Spec     : docs/spec/vaubaan-gateway.md §5 (plugins) ; docs/spec/gateway-risk-model.md §7.
 * ADR      : docs/decisions/plugin-contract-and-credential-spec.md.
 * Handbook : docs/handbook/providers/ssh.md ; guide : plugins/README.md.
 *
 * The plugin imports `@vaubaan/plugin-sdk` only (and `ssh2` for the
 * transport). `definePlugin` validates the definition at import time ; the
 * YAML catalog is loaded here, once, when the module is first imported (that
 * is, at gateway boot). `createSshPlugin({ transport })` builds the same
 * plugin over a fake transport for tests.
 *
 * The block at the end re-exports the v4 shapes `apps/gateway` still imports.
 * They are deleted in P1.6 with the v4 pipeline.
 */

import {
  catalogPathNextTo,
  definePlugin,
  loadCatalogFile,
  type ProviderPlugin,
} from '@vaubaan/plugin-sdk';

import { classifySsh, PROVIDER, resolveExecArgs } from './classify.ts';
import {
  SSH_DEFAULT_PORT,
  SSH_FINGERPRINT_PATTERN,
  SSH_HOST_PATTERN,
  SSH_PORT_PATTERN,
  SSH_USER_PATTERN,
  fingerprintOf,
  hostKeyMatches,
  normalizeFingerprint,
  sshCredential,
  sshTarget,
} from './credential.ts';
import { sshDataModel } from './data-model.ts';
import { createSshRuntime, DISCOVERY_PROBE, hostResource } from './execute.ts';
import { DEFAULT_TIMEOUT_S, MAX_TIMEOUT_S, SSH_EXEC, sshTools } from './tools.ts';
import {
  MAX_READY_TIMEOUT_MS,
  MAX_STDERR_BYTES,
  MAX_STDOUT_BYTES,
  SshHostKeyMismatchError,
  ssh2Transport,
} from './transport.ts';
import type { SshRuntimeOptions } from './execute.ts';

// The YAML sits next to this module ; `catalogPathNextTo` keeps the path a
// filesystem path the bundler leaves alone (ADR plugin-catalog-path-and-standalone-tracing).
export const SSH_CATALOG_PATH = catalogPathNextTo(import.meta.url);

export const sshCatalog = loadCatalogFile(SSH_CATALOG_PATH);

/** Build the plugin over a transport of your choice ; the default export uses `ssh2`. */
export function createSshPlugin(options: SshRuntimeOptions = {}): ProviderPlugin {
  const runtime = createSshRuntime(options);
  return definePlugin({
    id: PROVIDER,
    displayName: 'SSH (bash)',
    version: '1.0.0',
    description:
      'Shell commands on a host over SSH — inspection on a read whitelist, writes priced by class (destructive, package, service, sudo).',
    docsUrl:
      'https://github.com/sbw-vaubaan/vaubaan-gateway/blob/main/docs/handbook/providers/ssh.md',
    tools: sshTools,
    dataModel: sshDataModel,
    catalog: sshCatalog.catalog,
    credential: sshCredential,
    classify: classifySsh,
    execute: runtime.execute,
    discoverResources: runtime.discoverResources,
  });
}

export const sshPlugin = createSshPlugin();

export default sshPlugin;

export {
  classifySsh,
  createSshRuntime,
  fingerprintOf,
  hostKeyMatches,
  hostResource,
  normalizeFingerprint,
  resolveExecArgs,
  ssh2Transport,
  sshCredential,
  sshDataModel,
  sshTarget,
  sshTools,
  SshHostKeyMismatchError,
  DEFAULT_TIMEOUT_S,
  DISCOVERY_PROBE,
  MAX_READY_TIMEOUT_MS,
  MAX_STDERR_BYTES,
  MAX_STDOUT_BYTES,
  MAX_TIMEOUT_S,
  SSH_DEFAULT_PORT,
  SSH_EXEC,
  SSH_FINGERPRINT_PATTERN,
  SSH_HOST_PATTERN,
  SSH_PORT_PATTERN,
  SSH_USER_PATTERN,
};
export type { ExecArgs } from './classify.ts';
export type { SshTarget } from './credential.ts';
export type { SshRuntime, SshRuntimeOptions } from './execute.ts';
export type { ExecResult, SshExecOptions, SshTransport } from './transport.ts';
export {
  isDestructive,
  isPackageInstall,
  isServiceControl,
  looksLikeSecretFileRead,
  profileCommandLine,
  splitCommandLine,
  stripPrivilegePrefix,
  MAX_CMD_LENGTH,
  type CommandProfile,
  type SplitLine,
} from './command-classes.ts';
export { isReadAllowed } from './policy.ts';

// Annotated bash scripts — parser, argument materialisation and invocation
// builder, moved here from `apps/gateway/src/lib/bash` (P1.2i). Not wired to
// a tool yet : an owner-curated script needs per-connection configuration
// the connection model does not carry (see the handbook, "Annotated scripts").
export {
  parseAnnotatedBash,
  summarize,
  ParseError,
  type ParsedArg,
  type ParsedScript,
  type ParsedTool,
} from './bash/parse.ts';
export { materializeArgs, type MaterializeResult, type RawArgs } from './bash/args.ts';
export { buildToolInvocation, type BuiltCommand } from './bash/exec.ts';

// ─── legacy v4, deleted in P1.6 ──────────────────────────────────────────────
// Same import paths as before so `apps/gateway` keeps compiling until the v4
// pipeline goes. Nothing new may import these.

/** @deprecated legacy v4, deleted in P1.6 — use `sshPlugin.tools`. */
export { availableTools as sshAvailableTools } from './tools.ts';
/** @deprecated legacy v4, deleted in P1.6 — use `sshPlugin.execute`. */
export { sshExec } from './execute.ts';
/** @deprecated legacy v4, deleted in P1.6. */
export type { VpsSshBinding } from './execute.ts';
/** @deprecated legacy v4, deleted in P1.6 — use `sshPlugin.catalog` (same object, loaded from the YAML). */
export const sshRiskCatalog = sshCatalog.catalog;
/** @deprecated legacy v4, deleted in P1.6 — use `sshPlugin.classify(tool, args, resources)`. */
export { classifySshV4, type ClassifyV4Result } from './risk-classifier.ts';
