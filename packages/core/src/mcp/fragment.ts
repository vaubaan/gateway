/**
 * Re-export of the `McpServerFragment` shape so `@crm/core/mcp`
 * consumers don't have to take an indirect dep on `@crm/catalog`. The
 * canonical definition lives in `@crm/catalog/resource-kind.ts` (spec
 * §5.1) — we mirror it structurally to keep the dep direction
 * `web → catalog → core`.
 *
 * If the catalogue ever evolves the shape, both copies must move in
 * lockstep; the registry-level unit test (`packages/crm-catalog/tests`)
 * pins the catalogue side and the composer test exercises the shape we
 * accept here.
 */

export interface McpServerFragment {
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly [extra: string]: unknown;
}
