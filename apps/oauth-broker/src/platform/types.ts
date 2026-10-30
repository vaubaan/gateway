/**
 * The one boundary between the broker and the enclave platform (ADR D5). The
 * core reads `attested` and calls these two methods, and nothing else of the
 * platform.
 */
export interface Attestation {
  /** `gcp-confidential-space`, or `none` for the development adapter. */
  readonly platform: string;
  /** The platform's evidence, as the gateway's verifier for that platform reads it. */
  readonly evidence: string;
}

export interface PlatformAdapter {
  readonly name: string;
  /**
   * False when the platform has nothing to attest (`unattested`): the broker
   * then opens one plain HTTP listener behind the platform's TLS, and never
   * calls `attest`. The development adapter attests, with unsigned evidence.
   */
  readonly attested: boolean;
  /** Evidence that binds every nonce given, in order. */
  attest(nonces: readonly string[]): Promise<Attestation>;
  /** The secret of that name, released by the platform's key service. */
  unsealSecret(name: string): Promise<string>;
}

/** The audience of every attestation the broker asks for; the gateway checks it. */
export const ATTESTATION_AUDIENCE = 'oauth-broker-attestation';

export class PlatformError extends Error {
  override name = 'PlatformError';
}
