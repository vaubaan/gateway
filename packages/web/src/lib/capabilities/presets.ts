/**
 * Curated capability presets surfaced in the token-creation / token-edit UIs.
 *
 * Each preset maps a human label to a capability *shorthand* string (the wire
 * form, cf. @vaubaan/shared `capability.ts`). The UI submits the checked
 * shorthands as `capabilities: string[]`; the API parses + stores the full
 * tuples. Operators who need a capability not in this list can type an
 * arbitrary shorthand in the free-text field.
 */
export interface CapabilityPreset {
  /** Human-readable label shown next to the checkbox. */
  label: string;
  /** Capability shorthand submitted to the API, e.g. `runtime:apply@prod`. */
  value: string;
}

export const CAPABILITY_PRESETS: readonly CapabilityPreset[] = [
  { label: 'Read code', value: 'source:read' },
  { label: 'Propose code (branches, PRs)', value: 'source:propose' },
  { label: 'Merge / apply to main', value: 'source:apply' },
  { label: 'Deploy to staging', value: 'runtime:apply@staging' },
  { label: 'Deploy to prod', value: 'runtime:apply@prod' },
  { label: 'Read runtime (logs/status)', value: 'runtime:read' },
  { label: 'Change prod config/secrets', value: 'runtime/settings:apply@prod' },
  { label: 'Read data (staging)', value: 'data:read@staging' },
  { label: 'Read data (prod)', value: 'data:read@prod' },
] as const;

/** The set of shorthand values that have a preset label, for quick lookup. */
export const PRESET_VALUES: ReadonlySet<string> = new Set(CAPABILITY_PRESETS.map((p) => p.value));
