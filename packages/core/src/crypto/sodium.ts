import sodium from 'libsodium-wrappers-sumo';

type Sodium = typeof sodium;

let cached: Sodium | null = null;

/**
 * Returns the libsodium instance after awaiting its WASM init. Cached
 * module-level so we never pay the init cost twice in a process or
 * browser tab. Callers must `await` before invoking any `sodium.*` API.
 */
export async function getSodium(): Promise<Sodium> {
  if (cached) return cached;
  await sodium.ready;
  cached = sodium;
  return sodium;
}
