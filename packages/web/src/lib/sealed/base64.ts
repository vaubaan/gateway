/**
 * Tiny isomorphic base64 / bytes helpers used by the sealed components.
 *
 * We deliberately do NOT pull in `Buffer` here (browser-bundle bloat).
 * `atob` / `btoa` are part of the platform spec on both Node 20+ and
 * every modern browser.
 */

export function base64ToBytes(input: string): Uint8Array {
  const bin = atob(input);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64(input: Uint8Array): string {
  let s = '';
  for (let i = 0; i < input.length; i++) s += String.fromCharCode(input[i]!);
  return btoa(s);
}
