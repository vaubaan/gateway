/**
 * Log redaction (spec §6 "no secret in logs").
 *
 * - Mission tokens `vbn_<kind>_<prefix8>_<secret32>` keep their prefix (the
 *   audit identifies a token by prefix) and lose the secret.
 * - Every configured secret (master keys, client secrets, private keys,
 *   bootstrap token) is replaced wherever its exact value appears.
 */
const TOKEN = /vbn_(live|test)_([A-Za-z0-9]{8})_[A-Za-z0-9]{32}/g;
export const REDACTED = '[redacted]';

export type Redactor = (text: string) => string;

export function createRedactor(secrets: readonly string[]): Redactor {
  // Longest first so a secret that contains another is replaced whole.
  const values = [...new Set(secrets.filter((s) => s.length > 0))].sort(
    (a, b) => b.length - a.length,
  );
  return (text) => {
    let out = text.replace(TOKEN, `vbn_$1_$2_${REDACTED}`);
    for (const secret of values) {
      out = out.split(secret).join(REDACTED);
      // Secrets also appear JSON-escaped (private keys contain newlines).
      const escaped = JSON.stringify(secret).slice(1, -1);
      if (escaped !== secret) out = out.split(escaped).join(REDACTED);
    }
    return out;
  };
}
