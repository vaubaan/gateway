/**
 * Centralised reader for Supabase public env vars.
 *
 * NEXT_PUBLIC_* vars are inlined at build time by Next.js, so they MUST
 * be referenced literally (not via dynamic indexing) for static analysis
 * to pick them up.
 *
 * The service-role key is intentionally NOT read here — that lives in
 * server-only modules to make accidental client exposure impossible.
 */

export interface SupabasePublicConfig {
  readonly url: string;
  readonly anonKey: string;
}

export function requireSupabaseConfig(): SupabasePublicConfig {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error(
      'Missing Supabase config: set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY ' +
        '(see packages/web/.env.local.example).',
    );
  }
  return { url, anonKey };
}
