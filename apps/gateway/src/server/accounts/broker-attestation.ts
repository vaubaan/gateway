/**
 * The gateway's verifier of an OAuth broker's attestation (ADR
 * oauth-broker-stateless-in-an-attested-enclave D4, D5, D6). Before it sends
 * anything to a broker, the gateway asks it `POST /attest` (no body) on a TLS
 * account and checks the answer `{platform, evidence}` here:
 *
 *   - the platform adapter named by `platform` checks the evidence — signed by
 *     the platform's root of trust, debug off, and bound to the SHA-256 of the
 *     TLS key the connection presented — and says which code runs (its
 *     measurement), when the evidence was issued and until when it holds;
 *   - the evidence is at most `MAX_EVIDENCE_AGE_MS` old: the broker serves a
 *     cached attestation it refreshes every five minutes, so there is no
 *     nonce of the gateway's. A replayed attestation is harmless: it names the
 *     enclave's TLS key, and whoever replays it does not hold that key's
 *     private half, so the account it answers on presents another key;
 *   - the measurement must be on the allowlist shipped with this release
 *     (`broker-measurements.json`): entries `{platform, measurement,
 *     broker_version}`.
 *
 * One adapter per platform (`AttestationPlatform`); the production set is
 * `productionAttestationKit`'s (`attestation-kit.ts`), and nothing in the configuration adds an
 * adapter or an allowlist entry: `oauth_brokers.<name>.attestation: none`
 * skips the check for one broker, it never widens what is admitted. Test
 * adapters are handed in by code (the fake broker's kit), never by name.
 *
 * Every refusal is an `AttestationRefused` whose message is the gateway's own
 * short sentence, never a claim value or the broker's text.
 *
 * Handbook: docs/handbook/oauth-broker-contract.md ("Attestation").
 */
import { createHash, type X509Certificate } from 'node:crypto';

/** The `aud` every attestation token a broker hands the gateway carries. */
export const BROKER_ATTESTATION_AUDIENCE = 'oauth-broker-attestation';
/** Evidence issued longer ago than this is refused (the broker refreshes it every five minutes). */
export const MAX_EVIDENCE_AGE_MS = 10 * 60_000;
/** Evidence issued this far in the future is refused (clocks differ a little). */
const CLOCK_TOLERANCE_MS = 60_000;
/** A verified key is pinned for the evidence's lifetime, an hour at most (D6). */
export const MAX_PIN_MS = 60 * 60_000;
/** What an account shows when the release admits no broker version (the allowlist is empty). */
export const NO_ADMITTED_VERSION = 'no attested broker version admitted by this release';

/** One admitted broker version: on this platform, this measurement is that release of the broker. */
export interface BrokerMeasurement {
  readonly platform: string;
  /** What the platform reports for the image (Confidential Space: the image digest). */
  readonly measurement: string;
  readonly broker_version: string;
}

/** What the evidence must carry: the key of the account it came on. */
export interface AttestationExpectation {
  /** base64url(SHA-256(DER SubjectPublicKeyInfo)) of the certificate the connection presented. */
  readonly spkiHash: string;
  readonly now: Date;
}

/** What a platform adapter vouches for, once the evidence checked out. */
export interface AttestedClaims {
  readonly measurement: string;
  /** Epoch milliseconds when the platform issued the evidence. */
  readonly issuedAt: number;
  /** Epoch milliseconds after which the evidence no longer holds. */
  readonly expiresAt: number;
}

/** One enclave platform's verifier (D5). */
export interface AttestationPlatform {
  /** The `platform` value of `POST /attest` this adapter reads (`gcp-confidential-space`). */
  readonly platform: string;
  /** Checks the evidence; throws `AttestationRefused` when anything is off. */
  verify(evidence: unknown, expected: AttestationExpectation): Promise<AttestedClaims>;
}

/** The adapters and the allowlist a verifier works with. */
export interface BrokerAttestationKit {
  readonly platforms: readonly AttestationPlatform[];
  readonly allowlist: readonly BrokerMeasurement[];
}

/** An attestation that did not check out. The message is the gateway's sentence. */
export class AttestationRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttestationRefused';
  }
}

/** The broker an attestation admitted. */
export interface AdmittedBroker {
  readonly platform: string;
  readonly measurement: string;
  readonly brokerVersion: string;
  readonly expiresAt: number;
}

export class AttestationVerifier {
  private readonly platforms: ReadonlyMap<string, AttestationPlatform>;

  constructor(private readonly kit: BrokerAttestationKit) {
    this.platforms = new Map(kit.platforms.map((p) => [p.platform, p] as const));
  }

  /** False when the release admits no broker version on any platform it can verify. */
  get admitsAny(): boolean {
    return this.kit.allowlist.some((entry) => this.platforms.has(entry.platform));
  }

  /** The answer of `POST /attest`, checked; throws `AttestationRefused`. */
  async verify(answer: unknown, expected: AttestationExpectation): Promise<AdmittedBroker> {
    if (!this.admitsAny) throw new AttestationRefused(NO_ADMITTED_VERSION);
    const record = isRecord(answer) ? answer : null;
    const platformName = record?.platform;
    if (typeof platformName !== 'string')
      throw new AttestationRefused('the answer names no platform');
    const platform = this.platforms.get(platformName);
    if (!platform) throw new AttestationRefused('the platform is not one this release verifies');
    const claims = await platform.verify(record?.evidence, expected);
    const admitted = this.kit.allowlist.find(
      (entry) => entry.platform === platformName && entry.measurement === claims.measurement,
    );
    if (!admitted) {
      throw new AttestationRefused('the broker runs a version this release does not admit');
    }
    const now = expected.now.getTime();
    if (claims.expiresAt <= now) throw new AttestationRefused('the attestation has expired');
    if (now - claims.issuedAt > MAX_EVIDENCE_AGE_MS) {
      throw new AttestationRefused('the attestation is older than ten minutes');
    }
    if (claims.issuedAt - now > CLOCK_TOLERANCE_MS) {
      throw new AttestationRefused('the attestation is issued in the future');
    }
    return {
      platform: platformName,
      measurement: claims.measurement,
      brokerVersion: admitted.broker_version,
      expiresAt: claims.expiresAt,
    };
  }
}

/** The allowlist file, checked: a malformed entry is a build error, not a silent widening. */
export function parseMeasurements(raw: unknown): BrokerMeasurement[] {
  if (!Array.isArray(raw)) throw new Error('broker-measurements.json: not a list');
  return raw.map((entry: unknown, i) => {
    if (
      !isRecord(entry) ||
      !nonEmpty(entry.platform) ||
      !nonEmpty(entry.measurement) ||
      !nonEmpty(entry.broker_version)
    ) {
      throw new Error(
        `broker-measurements.json: entry ${i} is not {platform, measurement, broker_version}`,
      );
    }
    return {
      platform: entry.platform,
      measurement: entry.measurement,
      broker_version: entry.broker_version,
    };
  });
}

/** base64url(SHA-256(DER SubjectPublicKeyInfo)) of a certificate's key. */
export function spkiHashOf(certificate: X509Certificate): string {
  const der = certificate.publicKey.export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('base64url');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
