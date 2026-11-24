/**
 * Whether the running instance is in local mode (ADR
 * local-mode-for-an-instance-on-this-computer), published once at boot — by the
 * composition root, or by setup mode before it — for the pages that say so without
 * reaching the root: the build footer is on pages setup mode serves too. `false`
 * before anything is published (a page rendered by the tests).
 */
const LOCAL_MODE_KEY = Symbol.for('vaubaan.gateway.localMode');

export function publishLocalMode(local: boolean): void {
  (globalThis as Record<symbol, unknown>)[LOCAL_MODE_KEY] = local;
}

export function publishedLocalMode(): boolean {
  return (globalThis as Record<symbol, unknown>)[LOCAL_MODE_KEY] === true;
}
