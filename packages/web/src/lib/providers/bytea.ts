/**
 * Bytea (de)serialisation helpers for `provider_admins` tokens.
 *
 * Why this exists: passing a Node Buffer (or Uint8Array) to Supabase JS for a
 * bytea column goes through JSON serialisation, where Buffer.prototype.toJSON
 * returns `{"type":"Buffer","data":[…]}`. That object's JSON gets written to
 * the column verbatim, producing garbage. Always use `encodeByteaHex(str)` on
 * write — it produces the `\x<hex>` literal which PostgREST forwards to
 * Postgres as a real bytea hex literal.
 *
 * Both read paths (cloud-providers UI loader and the gateway runtime) decode
 * via `decodeBytea`, which also unwraps the legacy `{type:'Buffer',data:[…]}`
 * envelope so installs that landed before this fix keep working without a
 * reconnect.
 */

export function encodeByteaHex(s: string): string {
  return '\\x' + Buffer.from(s, 'utf8').toString('hex');
}

export function decodeBytea(raw: unknown): Uint8Array | null {
  if (raw === null || raw === undefined) return null;
  if (raw instanceof Uint8Array) return raw;
  if (typeof raw !== 'string') return null;
  const hex = raw.startsWith('\\x') ? raw.slice(2) : raw;
  if (!/^[0-9a-f]*$/i.test(hex) || hex.length % 2 !== 0) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  // Legacy rows: Buffer.from(...) used to be sent through Supabase JS, which
  // serialised it via Buffer.prototype.toJSON to `{"type":"Buffer","data":[…]}`
  // — the bytea ended up holding the UTF-8 bytes of THAT JSON literal instead
  // of the token bytes themselves. Detect and unwrap so old installs keep
  // working without a reconnect.
  if (out.length > 20) {
    const head = new TextDecoder().decode(out.slice(0, 20));
    if (head.startsWith('{"type":"Buffer"')) {
      try {
        const wrapped = JSON.parse(new TextDecoder().decode(out)) as {
          type?: string;
          data?: number[];
        };
        if (wrapped.type === 'Buffer' && Array.isArray(wrapped.data)) {
          return new Uint8Array(wrapped.data);
        }
      } catch {
        // fall through — leave the malformed bytes as-is
      }
    }
  }
  return out;
}
