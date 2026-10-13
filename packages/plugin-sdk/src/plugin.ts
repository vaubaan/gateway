/**
 * The plugin contract — `ProviderPlugin`.
 *
 * Spec : docs/spec/vaubaan-gateway.md §5 ("Provider plugins — two
 *        responsibilities : classify and execute ; they also declare how to
 *        obtain and refresh a credential, how to discover resources, and
 *        ship at least one preset") ; docs/spec/gateway-risk-model.md §7.
 * ADR  : docs/decisions/plugin-contract-and-credential-spec.md.
 *
 * The plugin knows neither the mission, nor the accepted risks, nor the
 * budget. It classifies a call into slices, and it executes a call with the
 * credential the host hands it. The host (gateway) intersects, decides,
 * counts, audits.
 */

import type {
  DataModel,
  McpToolDeclaration,
  McpToolResult,
  Resource,
  RiskCatalog,
  ScopeCaps,
  Slice,
} from '@vaubaan/shared';

import type { CredentialSecret, CredentialSpec, ProviderAppConfig } from './credential.ts';

/**
 * Result of `classify`. `denied` is the plugin's own refusal, before any
 * risk is evaluated : unknown tool, retired tool, arguments that cannot be
 * mapped to a slice. The host audits it as a refused call.
 */
export type ClassifyOutcome = { readonly slices: readonly Slice[] } | { readonly denied: string };

/** Minimal logger the host injects. No `console` in plugins. */
export interface PluginLogger {
  debug(message: string, data?: Readonly<Record<string, unknown>>): void;
  info(message: string, data?: Readonly<Record<string, unknown>>): void;
  warn(message: string, data?: Readonly<Record<string, unknown>>): void;
  error(message: string, data?: Readonly<Record<string, unknown>>): void;
}

/**
 * What a plugin receives whenever it talks to its provider on behalf of a
 * connection : the decrypted credential (in memory only), the company's app
 * configuration for this provider, and the IO primitives. The plugin never
 * reads `process.env`, never opens its own `fetch` : both are injected so
 * tests run with `mockFetch` and never reach a real provider.
 */
export interface ConnectionContext {
  readonly credential: CredentialSecret;
  /** The company's registered app for this provider (client id, app id…). Empty for `api-key`. */
  readonly appConfig: ProviderAppConfig;
  readonly fetch: typeof fetch;
  readonly signal?: AbortSignal;
  readonly logger?: PluginLogger;
}

/** The context of one allowed `tools/call`. */
export interface ExecuteContext extends ConnectionContext {
  /** The resources of this connection the mission may touch. */
  readonly resources: readonly Resource[];
  /** Free-form agent label carried by the call ; attribution only. */
  readonly agentLabel?: string | null;
}

export interface ProviderPlugin {
  /** Provider id : lowercase slug (`github`, `cloudflare-dns`). Prefixes every tool name. */
  readonly id: string;
  /** Label shown in the UI (`GitHub`, `Cloudflare DNS`). */
  readonly displayName: string;
  /** Semver of the plugin. Reported by telemetry ; bump on every published change. */
  readonly version: string;
  /** One-line description for the providers page. */
  readonly description?: string;
  /** URL of the plugin's modelling handbook, when published. */
  readonly docsUrl?: string;

  /** The MCP tools the plugin exposes, named `<prefix>__<local>`. May be empty for an experimental, classifier-only plugin. */
  readonly tools: readonly McpToolDeclaration[];
  /** Declarative graph of the provider's entities (risk-model spec §2). */
  readonly dataModel: DataModel;
  /** The risk catalog, loaded from `risk-catalog.yaml` at boot, presets included. */
  readonly catalog: RiskCatalog;
  /** How a connection to this provider is obtained, stored and refreshed. */
  readonly credential: CredentialSpec;

  /**
   * Classify a concrete call into the slices it touches. Pure : no IO, no
   * credential. `resources` are the mission's resources on this connection,
   * so the classifier can derive the environment and refuse refs the
   * arguments do not identify. A call touching several entities returns
   * several slices.
   */
  classify(
    tool: string,
    args: Readonly<Record<string, unknown>>,
    resources: readonly Resource[],
  ): ClassifyOutcome;

  /**
   * Execute an allowed call against the provider. Throws
   * `UpstreamAuthError` when the provider rejects the credential (the host
   * then tries `refresh`, and marks the connection `expired` if that fails).
   */
  execute(
    ctx: ExecuteContext,
    tool: string,
    args: Readonly<Record<string, unknown>>,
  ): Promise<McpToolResult>;

  /**
   * List the resources reachable through a freshly connected credential
   * (repositories, projects, zones…). Called at connection time and on the
   * owner's "refresh resources". Returned refs are the ones `classify` will
   * see in `resources`.
   */
  discoverResources(ctx: ConnectionContext): Promise<readonly Resource[]>;

  /**
   * Derive the environment a slice falls under when the provider carries
   * it in the call itself rather than on the resource : the `env[<label>]`
   * segment for Vercel, the branch for GitHub (spec vaubaan-gateway §0
   * "Resource"). Pure. Return `undefined` when the slice carries no
   * environment of its own ; the host then falls back to the owner's label
   * on the matching resource (`envResolverFor` in `@vaubaan/policy-engine`).
   * Absent when the environment always lives on the resource label
   * (Supabase, Railway, Stripe's per-mode resources). `envFromSliceSegment`
   * builds the common segment-lookup implementation.
   */
  envOf?(slice: Slice, resources: readonly Resource[]): string | undefined;

  /**
   * Obtain a fresh credential from an expired one (OAuth refresh token,
   * re-minted installation token). Absent when the credential kind does not
   * expire. Must not mutate its input.
   */
  refresh?(ctx: ConnectionContext): Promise<CredentialSecret>;

  /**
   * Rewrite the arguments so the call respects the scope caps the mission
   * resolved (page size, time window). Pure. Return the input when nothing
   * applies ; throw when a cap cannot be enforced upstream so the host
   * refuses the call.
   */
  normalizeForCaps?(
    args: Readonly<Record<string, unknown>>,
    caps: ScopeCaps,
  ): Readonly<Record<string, unknown>>;

  /**
   * Fill in arguments the mission leaves no choice over (the single
   * repository, the single project). Pure. Only invoked when the host flag
   * `argNormalization` is on (plan §8-Q4, default off) ; see `flags.ts`.
   */
  normalizeArgs?(
    args: Readonly<Record<string, unknown>>,
    resources: readonly Resource[],
  ): Readonly<Record<string, unknown>>;
}
