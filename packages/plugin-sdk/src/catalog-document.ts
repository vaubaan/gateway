/**
 * The structure of a parsed catalog document : known keys only, the
 * service, the version and date, the risks (`catalog-risk-entry.ts`) and
 * the macro-actions. `structuralIssues` builds a typed catalog from what it
 * checked, or lists every issue, path-qualified.
 *
 * Spec : docs/spec/gateway-risk-model.md §4, §4.6.
 */

import { isValidBudget, budgetIssues } from '@vaubaan/policy-engine';
import {
  isServiceId,
  type MacroAction,
  type MacroActionEntry,
  type RiskEntry,
} from '@vaubaan/shared';

import type { PluginCatalog } from './catalog-loader.ts';
import {
  child,
  isPositiveInt,
  normalizeDate,
  notAMapping,
  requireString,
  scoped,
  unknownKeys,
  type ParseContext,
  type Rec,
} from './catalog-parse.ts';
import { riskFrom } from './catalog-risk-entry.ts';
import { RETIRED_PRESETS_ISSUE } from './catalog-rules.ts';
import { isList, isRecord } from './guards.ts';

const CATALOG_KEYS = new Set([
  'service',
  'risks',
  'macro_actions',
  'catalog_version',
  'catalog_date',
]);
const CATALOG_KEYS_AND_RETIRED: ReadonlySet<string> = new Set([...CATALOG_KEYS, 'presets']);
const MACRO_ACTION_KEYS = new Set(['id', 'label', 'description', 'narrative', 'entries']);
/** Spec gateway-risk-model §4.6: a narrative is at most 600 characters. */
export const NARRATIVE_MAX_LENGTH = 600;
const MACRO_ENTRY_KEYS = new Set(['risk_id', 'quota', 'rate_limit']);
const RATE_LIMIT_KEYS = new Set(['max', 'window_seconds']);
const MACRO_ACTION_ID_PATTERN = /^[a-z][a-z0-9-]*$/;

export interface StructuralResult {
  readonly catalog?: PluginCatalog;
  readonly issues: string[];
}

/**
 * The name `service` had before SDK 0.9.4 (ADR one-word-per-thing-account-service-plugin),
 * refused since 1.0 with the word to write instead.
 */
const FORMER_SERVICE_KEY = 'provider';

/** A document that still names its service by the former key: the issue, the key dropped. */
function withCurrentServiceKey(doc: Rec, issues: string[]): Rec {
  if (!(FORMER_SERVICE_KEY in doc)) return doc;
  const { [FORMER_SERVICE_KEY]: _former, ...rest } = doc;
  issues.push(
    `${FORMER_SERVICE_KEY}: the name of service before SDK 0.9.4; write service (rebuild the plugin)`,
  );
  return rest;
}

/** Check the shape of a parsed document and build a typed catalog from it. */
export function structuralIssues(raw: unknown): StructuralResult {
  const issues: string[] = [];
  const doc = isRecord(raw) ? withCurrentServiceKey(raw, issues) : raw;
  if (!isRecord(doc))
    return {
      issues: ['document: expected a mapping with `service`, `risks` and `macro_actions`'],
    };
  const root: ParseContext = { at: '', issues };
  // A retired key reads as retired, not as unknown.
  if ('presets' in doc) issues.push(RETIRED_PRESETS_ISSUE);
  unknownKeys(doc, CATALOG_KEYS_AND_RETIRED, root);

  const service = serviceFrom(doc, root);
  const catalogVersion = catalogVersionFrom(doc, root);
  const catalogDate = catalogDateFrom(doc, root);
  // A service that is not a slug is reported above ; as a string it still
  // names the catalog the risk ids are compared with.
  const declaredService = typeof doc.service === 'string' ? doc.service : null;
  const risks = risksFrom(doc.risks, child(root, 'risks'), declaredService);
  const macroActions = macroActionsFrom(doc.macro_actions, child(root, 'macro_actions'));

  if (issues.length > 0 || service === undefined) return { issues };
  const catalog: PluginCatalog = {
    service,
    risks,
    macro_actions: macroActions,
    ...(catalogVersion !== undefined ? { catalog_version: catalogVersion } : {}),
    ...(catalogDate !== undefined ? { catalog_date: catalogDate } : {}),
  };
  return { catalog, issues };
}

function serviceFrom(doc: Rec, ctx: ParseContext): string | undefined {
  const service = doc.service;
  if (typeof service === 'string' && isServiceId(service)) return service;
  ctx.issues.push(`service: expected a lowercase slug such as 'github' or 'cloudflare-dns'`);
  return undefined;
}

function catalogVersionFrom(doc: Rec, ctx: ParseContext): number | undefined {
  const version = doc.catalog_version;
  if (version === undefined) return undefined;
  if (isPositiveInt(version)) return version;
  ctx.issues.push('catalog_version: expected a positive integer');
  return undefined;
}

function catalogDateFrom(doc: Rec, ctx: ParseContext): string | undefined {
  if (doc.catalog_date === undefined) return undefined;
  const date = normalizeDate(doc.catalog_date);
  if (date === undefined) ctx.issues.push('catalog_date: expected an ISO date (YYYY-MM-DD)');
  return date;
}

function risksFrom(raw: unknown, ctx: ParseContext, service: string | null): RiskEntry[] {
  if (!isList(raw) || raw.length === 0) {
    ctx.issues.push(`${ctx.at}: expected a non-empty list`);
    return [];
  }
  return raw.flatMap((item, i) => {
    const risk = riskFrom(item, { at: `${ctx.at}[${i}]`, issues: ctx.issues }, service);
    return risk ? [risk] : [];
  });
}

// ── One macro-action ─────────────────────────────────────────────────────────

/**
 * One macro-action entry : a risk and its base budget, never a gate. The
 * shape is the loader's (known keys) ; whether the budget is acceptable is
 * `budgetIssues`, the rule `macroActionIssues` applies to every catalog.
 */
function macroEntryFrom(raw: unknown, ctx: ParseContext): MacroActionEntry | undefined {
  if (!isRecord(raw)) return notAMapping(ctx);
  unknownKeys(raw, MACRO_ENTRY_KEYS, ctx);
  if (isRecord(raw.rate_limit))
    unknownKeys(raw.rate_limit, RATE_LIMIT_KEYS, child(ctx, 'rate_limit'));
  const riskId = requireString(raw, 'risk_id', ctx);
  const budget = { quota: raw.quota, rate_limit: raw.rate_limit, gate: 'auto' };
  for (const issue of budgetIssues(budget)) {
    ctx.issues.push(`${ctx.at}.${issue.field}: ${issue.message}`);
  }
  if (!riskId || !isValidBudget(budget)) return undefined;
  return {
    risk_id: riskId,
    quota: budget.quota,
    rate_limit: {
      max: budget.rate_limit.max,
      window_seconds: budget.rate_limit.window_seconds,
    },
  };
}

function macroEntriesFrom(raw: unknown, ctx: ParseContext): MacroActionEntry[] {
  if (!isList(raw) || raw.length === 0) {
    ctx.issues.push(`${ctx.at}: expected a non-empty list`);
    return [];
  }
  return raw.flatMap((item, j) => {
    const entry = macroEntryFrom(item, { at: `${ctx.at}[${j}]`, issues: ctx.issues });
    return entry ? [entry] : [];
  });
}

function macroActionsFrom(raw: unknown, ctx: ParseContext): MacroAction[] {
  if (raw === undefined) return [];
  if (!isList(raw)) {
    ctx.issues.push(`${ctx.at}: expected a list`);
    return [];
  }
  return raw.flatMap((item, i) => {
    const action = macroActionFrom(item, { at: `${ctx.at}[${i}]`, issues: ctx.issues });
    return action ? [action] : [];
  });
}

/**
 * One macro-action : a slug, a label and a description in the connector's
 * words, an optional narrative, its entries.
 */
function macroActionFrom(raw: unknown, ctx: ParseContext): MacroAction | undefined {
  if (!isRecord(raw)) return notAMapping(ctx);
  const own = scoped(ctx);
  unknownKeys(raw, MACRO_ACTION_KEYS, own);
  const id = requireString(raw, 'id', own);
  if (id !== undefined && !MACRO_ACTION_ID_PATTERN.test(id))
    own.issues.push(`${own.at}.id '${id}' must be a lowercase slug`);
  const label = requireString(raw, 'label', own);
  const description = requireString(raw, 'description', own);
  const narrative = narrativeFrom(raw, own);
  const entries = macroEntriesFrom(raw.entries, child(own, 'entries'));
  if (!own.commit() || !id || !label || !description) return undefined;
  return narrative === undefined
    ? { id, label, description, entries }
    : { id, label, description, narrative, entries };
}

/** The optional narrative: absent, or a non-empty string of at most 600 characters (spec §15). */
function narrativeFrom(raw: Rec, ctx: ParseContext): string | undefined {
  if (raw.narrative === undefined) return undefined;
  const narrative = requireString(raw, 'narrative', ctx);
  if (narrative === undefined) return undefined;
  const text = narrative.trim();
  if (text.length > NARRATIVE_MAX_LENGTH) {
    ctx.issues.push(
      `${ctx.at}.narrative: ${text.length} characters, at most ${NARRATIVE_MAX_LENGTH} (spec §4.6)`,
    );
    return undefined;
  }
  return text;
}
