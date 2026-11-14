/**
 * The attestation adapters and the allowlist of this release (ADR
 * oauth-broker-stateless-in-an-attested-enclave D5, D7): Google Confidential
 * Space, and the broker versions of `broker-measurements.json`. This is the
 * only kit the gateway builds outside the tests; the configuration cannot
 * name another adapter or add an entry.
 */
import measurements from './broker-measurements.json';
import { gcpConfidentialSpace } from './attestation-gcp';
import { parseMeasurements, type BrokerAttestationKit } from './broker-attestation';

export function productionAttestationKit(io: {
  readonly fetch: typeof fetch;
}): BrokerAttestationKit {
  return {
    platforms: [gcpConfidentialSpace({ fetch: io.fetch })],
    allowlist: parseMeasurements(measurements),
  };
}
