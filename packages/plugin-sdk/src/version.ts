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
export const SDK_VERSION = '0.8.0';
