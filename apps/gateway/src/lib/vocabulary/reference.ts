// ─────────────────────────────────────────────────────────────────────────────
// Reference (the pages under `/reference`). Protocol names: service, plugin,
// risk, macro-action, trust level, tool, plane, slice pattern.
// ─────────────────────────────────────────────────────────────────────────────

export const REFERENCE_WORDS = {
  services: 'Services',
  /** The strip above a service's page: what this instance runs. */
  runs: 'This gateway runs',
  gitRemote: 'Its git remote for this service:',
} as const;

/**
 * The fourth segment of a macro-action's trust control: its lines were edited by hand,
 * so no trust level writes exactly them (spec §4.2).
 */
export const TRUST_LEVEL_CUSTOM = 'Custom';
