/**
 * Local mode's presets (ADR local-mode-for-an-instance-on-this-computer): the keys a
 * person on a laptop cannot decide, supplied as the variables they would have set.
 */
import type { EnvSource } from './secret-refs';
import { envNamesFor, keySpec } from './sources';
import { getPath, parseBool, type RawTree } from './tree';

/**
 * What local mode supplies, as the environment variable a person would have set. One
 * volume at `/data` holds the store and the generated key: the setup's download is the
 * copy kept apart (ADR local-mode-for-an-instance-on-this-computer).
 */
export const LOCAL_PRESETS: readonly {
  readonly path: string;
  readonly env: string;
  readonly value: string;
  /** Supplied only with the key file of local mode: a key the person gives is theirs to place. */
  readonly withPresetKey?: true;
}[] = [
  { path: 'public_url', env: 'VAUBAAN_PUBLIC_URL', value: 'http://localhost:3000' },
  { path: 'store.path', env: 'VAUBAAN_STORE_PATH', value: '/data/gateway.db' },
  { path: 'encryption.master_key', env: 'VAUBAAN_MASTER_KEY_FILE', value: '/data/master.key' },
  {
    path: 'encryption.generate_master_key',
    env: 'VAUBAAN_MASTER_KEY_GENERATE',
    value: 'true',
    withPresetKey: true,
  },
  {
    path: 'encryption.accept_key_beside_store',
    env: 'VAUBAAN_ACCEPT_KEY_BESIDE_STORE',
    value: 'true',
    withPresetKey: true,
  },
  {
    path: 'accept_shared_address_windows',
    env: 'VAUBAAN_ACCEPT_SHARED_ADDRESS_WINDOWS',
    value: 'true',
  },
];

/** Whether the configuration asks for local mode: the file's `local` wins over `VAUBAAN_LOCAL`. */
export function localModeAsked(env: EnvSource, fileTree: RawTree | null): boolean {
  const fromFile = fileTree === null ? undefined : getPath(fileTree, 'local');
  if (fromFile !== undefined) return fromFile === true;
  const raw = env[keySpec('local').env];
  return raw !== undefined && parseBool(raw) === true;
}

/**
 * The environment with local mode's presets added, each only where neither the file
 * nor any variable of its key (a secret's `_FILE` sibling included) says something.
 */
export function withLocalPresets(env: EnvSource, fileTree: RawTree | null): EnvSource {
  const out: Record<string, string | undefined> = { ...env };
  const unset = (path: string): boolean =>
    (fileTree === null || getPath(fileTree, path) === undefined) &&
    envNamesFor(path).every((name) => env[name] === undefined);
  const presetKey = unset('encryption.master_key');
  for (const preset of LOCAL_PRESETS) {
    if (!unset(preset.path) || (preset.withPresetKey && !presetKey)) continue;
    out[preset.env] = preset.value;
  }
  return out;
}
