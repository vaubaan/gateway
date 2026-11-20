/**
 * The version of this copy of the SDK.
 *
 * ADR plugins-bundled-or-pinned-by-the-operator : a pinned plugin declares the
 * SDK range it was built against (`peerDependencies["@vaubaan/plugin-sdk"]`
 * of its `package.json`) and the host refuses to start when its own SDK is
 * outside that range. This is the host's side of the check, and what
 * `scripts/build-plugin-bundle.mjs` writes as the range of a bundle (`^`).
 *
 * Always equal to `version` in `packages/plugin-sdk/package.json` (a test
 * checks it) : bump both together (docs/handbook/plugin-sdk.md "Versions of
 * the SDK").
 */
export const SDK_VERSION = '1.0.0';

/**
 * The first SDK whose run-time contract this one keeps (ADR
 * plugin-sdk-1-0-keeps-the-0-9-4-contract): a host of this SDK also loads a build whose
 * range lies between this version and its own.
 */
export const SDK_CONTRACT_SINCE = '0.9.4';

/**
 * The range a plugin built with the SDK `sdkVersion` declares
 * (`peerDependencies["@vaubaan/plugin-sdk"]`): a 1.x build also names the 0.9.4 contract, so
 * a gateway still on 0.9.4 loads it. Pure.
 */
export function sdkBuildRange(sdkVersion: string): string {
  return sdkVersion.startsWith('1.')
    ? `^${SDK_CONTRACT_SINCE} || ^${sdkVersion}`
    : `^${sdkVersion}`;
}
