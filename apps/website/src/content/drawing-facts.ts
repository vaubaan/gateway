/**
 * The facts the site's drawings are drawn from (`apps/website/drawings/`):
 * for the services of the two worked projects, every macro-action with its
 * permissions, their row, base budget and gates by trust level; for the whole
 * catalog, the counts. `scripts/drawing-facts.ts` writes them to
 * `drawings/facts.json`, which `drawings/gen.py` reads; a test fails when the
 * committed file no longer matches the catalogs, so a drawing never shows a
 * permission, a row or a limit the catalog has changed.
 */
import type { PluginInfo } from './plugins';

/** The services the two worked projects use (website spec §2.1). */
export const DRAWN_SERVICES = ['github', 'supabase', 'gmail', 'notion', 'google-calendar'] as const;

export const DRAWING_FACTS_FILE = 'apps/website/drawings/facts.json';

export interface DrawnEntry {
  readonly id: string;
  readonly row: number;
  /** The branch of the tree that put it on its row; null in row 1. */
  readonly reason: string | null;
  readonly quota: number;
  readonly careful: string | null;
  readonly trusting: string | null;
  readonly autonomous: string | null;
  readonly envs: readonly string[] | null;
}

export interface DrawnService {
  readonly name: string;
  readonly permissions: number;
  readonly planes: readonly string[];
  readonly macroActions: readonly {
    readonly id: string;
    readonly label: string;
    readonly description: string;
    readonly entries: readonly DrawnEntry[];
  }[];
}

export interface DrawingFacts {
  readonly totals: {
    readonly services: number;
    readonly planes: number;
    readonly permissions: number;
    readonly macroActions: number;
  };
  readonly services: Readonly<Record<string, DrawnService>>;
}

export function drawingFacts(plugins: readonly PluginInfo[]): DrawingFacts {
  const services: Record<string, DrawnService> = {};
  for (const id of DRAWN_SERVICES) {
    const plugin = plugins.find((p) => p.id === id);
    if (!plugin) throw new Error(`the drawings need the plugin '${id}'`);
    const risks = new Map(plugin.risks.map((r) => [r.id, r]));
    services[id] = {
      name: plugin.name,
      permissions: plugin.counts.permissions,
      planes: plugin.dataModel.planes.map((p) => p.slug),
      macroActions: plugin.macroActions.map((m) => ({
        id: m.id,
        label: m.label,
        description: m.description,
        entries: m.entries.map((e) => ({
          id: e.riskId,
          row: risks.get(e.riskId)?.row ?? 0,
          reason: risks.get(e.riskId)?.rowReason ?? null,
          quota: e.quota,
          careful: e.levels.careful.gate,
          trusting: e.levels.trusting.gate,
          autonomous: e.levels.autonomous.gate,
          envs: risks.get(e.riskId)?.acceptableInEnvs ?? null,
        })),
      })),
    };
  }
  return {
    totals: {
      services: plugins.length,
      planes: plugins.reduce((n, p) => n + p.dataModel.planes.length, 0),
      permissions: plugins.reduce((n, p) => n + p.counts.permissions, 0),
      macroActions: plugins.reduce((n, p) => n + p.counts.macroActions, 0),
    },
    services,
  };
}
