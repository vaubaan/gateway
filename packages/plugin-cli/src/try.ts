/**
 * `vaubaan-plugin try <tool> [<json args>]`: one call through the plugin and the policy
 * engine, as the gateway's risk step decides it, without a gateway (intent "Try a call
 * without a gateway").
 *
 * The plugin is the default export of the project's `src/index.ts`, bundled by esbuild
 * first (any TypeScript the author writes), its risk catalog read beside the bundle. The
 * call runs under a sample mission:
 *
 *   resources  `--resources ref[:env],…`, else those of the tool's first example
 *   accepted   `--accept <risk id>,…` (qualified as a mission stores them,
 *              `acme[prod].widget-write`), else every macro-action of the catalog at
 *              `--trust` (careful by default), as the mission form would tick them —
 *              never "Anything else", so a call the classifier sends to the fallback
 *              is refused here, the way a careful mission refuses it
 *   arguments  the JSON given, else the tool's first example's
 *
 * It prints the slices the classifier emitted, the risks they touch, and the decision.
 * Exit 0 when the call is allowed, 1 when it is refused or the classifier denies it.
 */

import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { build } from 'esbuild';

import { serializeSlice, type Resource, type ServicePlugin } from '@vaubaan/plugin-sdk';
import { decideCall, policyFromMacroActions, type CallDecision } from '@vaubaan/plugin-sdk/testing';

import { ArchiveError } from './archive.ts';

import { type TrustLevel } from './trust-levels.ts';

export { TRUST_LEVELS, type TrustLevel } from './trust-levels.ts';

export interface TryOptions {
  readonly pluginDir: string;
  readonly tool: string;
  /** The call's arguments as JSON; the tool's first example's when absent. */
  readonly args?: string;
  /** `ref[:env]`, comma separated. */
  readonly resources?: string;
  /** Qualified risk ids, comma separated. */
  readonly accept?: string;
  readonly trust?: TrustLevel;
}

export interface TryReport {
  readonly lines: readonly string[];
  readonly allowed: boolean;
}

function isPlugin(value: unknown): value is ServicePlugin {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { id?: unknown }).id === 'string' &&
    typeof (value as { classify?: unknown }).classify === 'function'
  );
}

/**
 * The project's plugin: the default export of `src/index.ts`, bundled into a folder of
 * its own with the YAML files beside it (`catalogPathNextTo` reads the catalog next to
 * the module), imported, then removed.
 */
export async function loadProjectPlugin(pluginDir: string): Promise<ServicePlugin> {
  const entry = join(pluginDir, 'src', 'index.ts');
  if (!existsSync(entry))
    throw new ArchiveError(`${entry} is missing: run this in a plugin project`);
  const out = mkdtempSync(join(tmpdir(), 'vaubaan-plugin-try-'));
  try {
    const result = await build({
      entryPoints: [entry],
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      write: false,
      logLevel: 'silent',
      banner: {
        js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
      },
    });
    const [bundle] = result.outputFiles;
    if (!bundle) throw new ArchiveError('esbuild wrote nothing');
    writeFileSync(join(out, 'index.mjs'), bundle.contents);
    for (const name of readdirSync(join(pluginDir, 'src'))) {
      if (name.endsWith('.yaml')) copyFileSync(join(pluginDir, 'src', name), join(out, name));
    }
    const module = (await import(pathToFileURL(join(out, 'index.mjs')).href)) as {
      default?: unknown;
    };
    if (!isPlugin(module.default)) {
      throw new ArchiveError(`${entry} has no plugin as its default export (definePlugin({...}))`);
    }
    return module.default;
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

function parseResources(spec: string, service: string): Resource[] {
  return spec
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .map((part) => {
      const at = part.lastIndexOf(':');
      const ref = at < 0 ? part : part.slice(0, at);
      const env = at < 0 ? null : part.slice(at + 1);
      return { service, ref, env, displayName: ref };
    });
}

function parseArgs(json: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new ArchiveError(`the arguments are not JSON: ${json}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ArchiveError('the arguments must be a JSON object ({"workspace": "ws-1"})');
  }
  return parsed as Record<string, unknown>;
}

function describeResource(resource: Resource): string {
  return resource.env ? `${resource.ref} (${resource.env})` : resource.ref;
}

function describeDecision(decision: CallDecision): string[] {
  switch (decision.outcome) {
    case 'classify-denied':
      return [`decision  denied by the classifier: ${decision.reason}`];
    case 'allowed':
      return ['decision  allowed'];
    case 'denied':
      return [
        `decision  refused: the mission did not accept ${decision.missing_risks.join(', ')}`,
        `hint      ${decision.hint}`,
      ];
  }
}

/** Runs one call under a sample mission. */
export function tryCall(plugin: ServicePlugin, options: Omit<TryOptions, 'pluginDir'>): TryReport {
  const { tool } = options;
  if (!plugin.tools.some((declared) => declared.name === tool)) {
    throw new ArchiveError(
      `${plugin.id} has no tool ${tool}; its tools: ${plugin.tools.map((t) => t.name).join(', ')}`,
    );
  }
  const example = plugin.examples?.[tool]?.[0];
  const args = options.args !== undefined ? parseArgs(options.args) : (example?.args ?? {});
  const resources =
    options.resources !== undefined
      ? parseResources(options.resources, plugin.id)
      : [...(example?.resources ?? [])];
  const trust = options.trust ?? 'careful';
  const envs = [...new Set(resources.flatMap((r) => (r.env ? [r.env] : [])))];
  const policy =
    options.accept === undefined
      ? policyFromMacroActions(
          plugin,
          Object.fromEntries(
            // Never "Anything else": a call landing on the fallback must show as refused.
            (plugin.catalog.macro_actions ?? []).map((a) => [a.id, trust]),
          ),
          { envs },
        )
      : null;
  const accepted =
    policy?.map((line) => line.risk_id) ??
    (options.accept ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id !== '');

  const lines = [
    `tool      ${tool}`,
    `args      ${JSON.stringify(args)}`,
    `resources ${resources.length === 0 ? '(none)' : resources.map(describeResource).join(', ')}`,
    policy === null
      ? `accepted  ${accepted.join(', ') || '(none)'}`
      : `accepted  every macro-action at ${trust} (${accepted.length} risks)`,
  ];
  const classified = plugin.classify(tool, args, resources);
  if (!('denied' in classified)) {
    lines.push(`slices    ${classified.slices.map(serializeSlice).join('\n          ')}`);
  }
  const decision = decideCall(plugin, { tool, args, resources, accepted });
  if (decision.outcome !== 'classify-denied') {
    const touched =
      decision.outcome === 'allowed'
        ? decision.risks_touched
        : [...decision.covered_risks, ...decision.missing_risks];
    const gates = new Map(policy?.map((line) => [line.risk_id, line.gate]) ?? []);
    lines.push(
      `risks     ${
        touched
          .map((risk) => (gates.has(risk) ? `${risk} (gate: ${gates.get(risk)})` : risk))
          .join('\n          ') || '(none)'
      }`,
    );
  }
  const asks =
    decision.outcome === 'allowed' &&
    decision.risks_touched.some(
      (risk) => policy?.find((line) => line.risk_id === risk)?.gate === 'approval',
    );
  lines.push(
    ...(asks
      ? ['decision  allowed once a person approves it (gate: approval)']
      : describeDecision(decision)),
  );
  return { lines, allowed: decision.outcome === 'allowed' };
}

export async function tryProjectCall(options: TryOptions): Promise<TryReport> {
  return tryCall(await loadProjectPlugin(options.pluginDir), options);
}
