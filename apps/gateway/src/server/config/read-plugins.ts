/**
 * What the instance runs and reaches: `plugins.*` (ADR
 * plugins-bundled-or-pinned-by-the-operator) and `oauth_brokers.<name>.*` (ADR
 * google-calendar-through-an-oauth-broker).
 */
import { parsePrivateHosts } from '../http/private-hosts';
import { OAUTH_BROKER_BLOCK, OAUTH_BROKER_ENV_PREFIX } from './named-blocks';
import {
  brokerSetProblems,
  isBrokerName,
  isBrokerProvider,
  OAUTH_BROKER_PROBLEMS,
  parseBrokerAttestation,
  parseBrokerUrl,
} from './oauth-brokers';
import { type Reader, show, typeName } from './reader';
import { envNamesFor, keySpec } from './sources';
import { isPlainObject } from './tree';
import type { OAuthBrokerConfig, PluginsConfig } from './types';

/** The shape of a plugin id (`isServiceId` of the SDK's vocabulary: a lowercase slug). */
const PLUGIN_ID_SHAPE = /^[a-z][a-z0-9-]*$/;

/**
 * `plugins.*` (ADR plugins-bundled-or-pinned-by-the-operator). `plugins.dir` is a path
 * read at boot (`server/plugins`), checked there; `plugins.enabled` a list of plugin ids.
 * Absent or empty (a blank variable, as for every key) is every plugin; whether each id
 * names a known plugin is checked once the plugins are loaded.
 */
export function readPlugins(r: Reader): PluginsConfig {
  const dir = r.string('plugins.dir')?.trim() ?? null;
  const safeMode = r.bool(keySpec('plugins.safe_mode'));
  const allowUnsigned = pluginIds(r, 'plugins.allow_unsigned') ?? [];
  const privateHosts = [...new Set(r.stringList('plugins.private_hosts'))];
  try {
    parsePrivateHosts(privateHosts);
  } catch (err) {
    r.issues.add(
      'plugins.private_hosts',
      err instanceof Error ? err.message.replace(/^plugins\.private_hosts: /, '') : String(err),
      envNamesFor('plugins.private_hosts'),
    );
  }
  return { dir, enabled: pluginIds(r, 'plugins.enabled'), allowUnsigned, safeMode, privateHosts };
}

/** A list of plugin ids, deduplicated; `null` when absent or empty. */
function pluginIds(r: Reader, path: string): string[] | null {
  const listed = r.stringList(path);
  if (listed.length === 0) return null;
  const malformed = listed.filter((id) => !PLUGIN_ID_SHAPE.test(id));
  if (malformed.length > 0) {
    r.issues.add(path, `not plugin ids: ${malformed.map(show).join(', ')}`, envNamesFor(path));
  }
  return [...new Set(listed)];
}

/**
 * `oauth_brokers.<name>.*` (ADR google-calendar-through-an-oauth-broker D1): one
 * broker per name, in the order of the tree; `url` and `key` required,
 * `providers` optional (none: the default broker), `attestation` `required`
 * (the default) or `none`. The rules across brokers
 * are `brokerSetProblems`'.
 */
export function readOAuthBrokers(r: Reader): OAuthBrokerConfig[] {
  const block = r.tree(OAUTH_BROKER_BLOCK.top);
  if (!block) return [];
  const out: OAuthBrokerConfig[] = [];
  for (const [name, value] of Object.entries(block)) {
    const base = `${OAUTH_BROKER_BLOCK.top}.${name}`;
    if (!isBrokerName(name)) {
      r.issues.add(base, OAUTH_BROKER_PROBLEMS.name, [`${OAUTH_BROKER_ENV_PREFIX}<NAME>_<FIELD>`]);
      continue;
    }
    if (!isPlainObject(value)) {
      r.issues.add(base, `expected a mapping of OAuth broker fields, got ${typeName(value)}`);
      continue;
    }
    const before = r.issues.items.length;
    const rawUrl = r.string(`${base}.url`, { required: true });
    const key = r.string(`${base}.key`, { required: true });
    let url: URL | undefined;
    if (rawUrl !== undefined) {
      const parsed = parseBrokerUrl(rawUrl);
      if (parsed.ok) url = parsed.url;
      else r.issues.add(`${base}.url`, parsed.problem, envNamesFor(`${base}.url`));
    }
    const providers = [...new Set(r.stringList(`${base}.providers`).map((p) => p.toLowerCase()))];
    for (const provider of providers) {
      if (!isBrokerProvider(provider)) {
        r.issues.add(
          `${base}.providers`,
          `${OAUTH_BROKER_PROBLEMS.provider}: "${provider}"`,
          envNamesFor(`${base}.providers`),
        );
      }
    }
    const attestation = parseBrokerAttestation(r.string(`${base}.attestation`));
    if (attestation === null) {
      r.issues.add(
        `${base}.attestation`,
        OAUTH_BROKER_PROBLEMS.attestation,
        envNamesFor(`${base}.attestation`),
      );
    } else if (attestation === 'required' && url?.protocol === 'http:') {
      r.issues.add(
        `${base}.url`,
        OAUTH_BROKER_PROBLEMS.attestedOverHttp,
        envNamesFor(`${base}.url`),
      );
    }
    if (r.issues.items.length > before || !url || !key || attestation === null) continue;
    out.push({ name, url, key, providers, attestation });
  }
  for (const problem of brokerSetProblems(out)) {
    r.issues.add(problem.path, problem.message, envNamesFor(problem.path));
  }
  return out;
}
