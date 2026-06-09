/**
 * Curated capability presets surfaced in the token-creation / token-edit UIs.
 *
 * Each preset maps a human label to a capability *notation* string (the wire
 * form, cf. @vaubaan/shared `capability.ts` — `provider:plane/level:action@env`).
 * The UI submits the checked notations as `capabilities: string[]`; the API
 * parses + stores the full tuples. Operators who need a capability not in this
 * list can type an arbitrary notation in the free-text field.
 */
export interface CapabilityPreset {
  /** Human-readable label shown next to the checkbox. */
  label: string;
  /** Capability notation, e.g. `vercel:runtime/deployment:write@prod`. */
  value: string;
}

export const CAPABILITY_PRESETS: readonly CapabilityPreset[] = [
  // GitHub (plane=repo)
  { label: 'GitHub — read code', value: 'github:repo/code:read' },
  { label: 'GitHub — write code on the main branch', value: 'github:repo/code:write@main' },
  { label: 'GitHub — mint a clone token', value: 'github:repo/access:read' },
  // Vercel (plane=runtime)
  { label: 'Vercel — read deployments / logs', value: 'vercel:runtime/deployment:read@prod' },
  { label: 'Vercel — deploy to staging', value: 'vercel:runtime/deployment:write@preview' },
  { label: 'Vercel — deploy to prod', value: 'vercel:runtime/deployment:write@prod' },
  { label: 'Vercel — change prod env vars', value: 'vercel:runtime/config:write@prod' },
  // Supabase (plane=db)
  { label: 'Supabase — read rows (staging)', value: 'supabase:db/rows:read@staging' },
  { label: 'Supabase — read rows (prod)', value: 'supabase:db/rows:read@prod' },
  { label: 'Supabase — read tables / schema (staging)', value: 'supabase:db/tables:read@staging' },
  // Railway (plane=runtime)
  { label: 'Railway — read deployments', value: 'railway:runtime/deployment:read' },
  { label: 'Railway — redeploy', value: 'railway:runtime/deployment:write' },
] as const;

/** The set of notation values that have a preset label, for quick lookup. */
export const PRESET_VALUES: ReadonlySet<string> = new Set(CAPABILITY_PRESETS.map((p) => p.value));
