/**
 * The plugin contract — `ServicePlugin`.
 *
 * Spec : docs/spec/vaubaan-gateway.md §5 ("Plugins — two
 *        responsibilities : classify and execute ; they also declare how to
 *        obtain and refresh a credential, how to discover resources") ;
 *        docs/spec/gateway-risk-model.md §4.6 (macro-actions), §7.
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
  Slice,
} from '@vaubaan/shared';

import type { CredentialSecret, CredentialSpec } from './credential.ts';
import type { EnvOf } from './env-of.ts';
import type { ToolSamples } from './samples.ts';
import type { GitRemoteCapability } from './git/remote.ts';
import type { ToolResultPartSink } from './streaming.ts';

/**
 * Result of `classify`. `denied` is the plugin's own refusal, before any
 * risk is evaluated : unknown tool, retired tool, arguments that cannot be
 * mapped to a slice. The host audits it as a refused call.
 */
export type ClassifyOutcome = { readonly slices: readonly Slice[] } | { readonly denied: string };

/**
 * What `classify` may know of the account a call goes through : the
 * non-secret fields of the form the account was made with (a Fly
 * organization slug, a team id), as the account recorded them. Never a
 * secret, never the credential. Absent when the host has none to give
 * (catalog tooling, tests) : a classifier then cites what the resources say,
 * or a wildcard, and never anything narrower than it knows.
 * docs/handbook/plugin-sdk.md.
 */
export interface ClassifyAccount {
  readonly fields: Readonly<Record<string, string>>;
}

/** Minimal logger the host injects. No `console` in plugins. */
export interface PluginLogger {
  debug(message: string, data?: Readonly<Record<string, unknown>>): void;
  info(message: string, data?: Readonly<Record<string, unknown>>): void;
  warn(message: string, data?: Readonly<Record<string, unknown>>): void;
  error(message: string, data?: Readonly<Record<string, unknown>>): void;
}

/**
 * What a plugin receives whenever it talks to its service on behalf of an
 * account : the decrypted credential (in memory only) and the IO
 * primitives. The plugin never
 * reads `process.env`, never opens its own `fetch` : both are injected so
 * tests run with `mockFetch` and never reach a real service.
 */
export interface AccountContext {
  readonly credential: CredentialSecret;
  readonly fetch: typeof fetch;
  readonly signal?: AbortSignal;
  readonly logger?: PluginLogger;
}

/**
 * @deprecated Renamed `AccountContext` (ADR one-word-per-thing-account-service-plugin);
 * kept for one minor so that a plugin pinned by an operator still compiles. Removed in 0.10.
 */
export type ConnectionContext = AccountContext;

/**
 * @deprecated Renamed `ClassifyAccount` (ADR one-word-per-thing-account-service-plugin);
 * kept for one minor so that a plugin pinned by an operator still compiles. Removed in 0.10.
 */
export type ClassifyConnection = ClassifyAccount;

/**
 * A small key/value cache the host scopes to ONE account and hands to
 * `execute`, for the short-lived upstream credential a plugin derives on
 * every call (a GitHub installation token minted from the App key). The
 * plugin chooses the key inside its account (`installation-token:<repo>`)
 * and the lifetime ; the host namespaces the entries per account, drops
 * them as soon as the service rejects a call or the account stops being
 * `active`, and never persists them. Absent : derive on every call.
 *
 * Only what `execute` itself needs goes in : a credential that is the
 * RESULT of a tool (handed to the executor) must be minted fresh, never
 * served from here.
 */
export interface UpstreamCredentialCache {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlSeconds: number): Promise<void>;
}

/** The context of one allowed `tools/call`. */
export interface ExecuteContext extends AccountContext {
  /** The resources of this account the mission may touch. */
  readonly resources: readonly Resource[];
  /** Free-form agent label carried by the call ; attribution only. */
  readonly agentLabel?: string | null;
  /** Account-scoped cache for derived upstream credentials ; see `UpstreamCredentialCache`. */
  readonly credentialCache?: UpstreamCredentialCache;
  /**
   * Hands the caller one part of the result as soon as the service
   * delivered it, for a tool whose service answers progressively. Optional
   * for both sides : a plugin that never calls it is unaffected, and a host
   * that does not provide it gets the complete result alone. `execute` still
   * returns the whole `McpToolResult` ; see `streaming.ts` for the rules
   * (`streamToolResult` applies them).
   */
  readonly emitPart?: ToolResultPartSink;
}

/** The singular and plural of what one resource of a service is called (`ServicePlugin.resourceNoun`). */
export interface ResourceNoun {
  readonly one: string;
  readonly other: string;
}

export interface ServicePlugin {
  /** Service id : lowercase slug (`github`, `cloudflare-dns`). Prefixes every tool name. */
  readonly id: string;
  /** Label shown in the UI (`GitHub`, `Cloudflare DNS`). */
  readonly displayName: string;
  /**
   * The brand icon of the service : the `d` of one SVG path on a 24×24 grid,
   * drawn to be filled with `currentColor`. The web interface shows it in
   * the brand colour of `iconColor` on a neutral fill, beside the service's
   * name (ADR service-icons-declared-by-the-plugin). Vendor the path in the
   * plugin (Simple Icons, CC0 1.0, is the usual source ; say so in a
   * comment) ; never a runtime dependency on an icon package. Optional in
   * the contract — a plugin without one is shown by two letters of its name ;
   * every plugin shipped with the gateway declares one (structural test).
   */
  readonly icon?: string;
  /**
   * The colour the icon is drawn in, `#RRGGBB` : the brand's own (Simple
   * Icons publishes one per icon), or one chosen for a service without a
   * brand. The interface draws a near-black colour in the ink of the dark
   * theme, so the mark stays visible there. Optional ; without it the icon is
   * drawn in the secondary ink. Every shipped plugin declares one (structural
   * test).
   */
  readonly iconColor?: string;
  /** Semver of the plugin. Reported by telemetry ; bump on every published change. */
  readonly version: string;
  /** One-line description for the services page. */
  readonly description?: string;
  /**
   * A short paragraph in plain words for the service reference of the web
   * interface (`/services/<id>`) : what one account is, what one
   * resource is, and where the environment of a call comes from. Two to
   * four sentences, no markup. Optional in the contract ; every plugin
   * shipped with the gateway fills it (structural test).
   */
  readonly summary?: string;
  /**
   * What one resource of this service is called in the interface, singular
   * and plural (`{ one: 'board', other: 'boards' }`) : the noun of what
   * `discoverResources` returns, so a page reads "3 boards" rather than
   * "3 resources". Lowercase, a word or two ; the interface capitalises it
   * where a sentence starts. For people only : the host decides nothing from
   * it. Optional ; without it the gateway says "resource" / "resources".
   */
  readonly resourceNoun?: ResourceNoun;
  /**
   * What each tool does, in a few words a person reads at a glance : a verb
   * and its object, sentence case, no final period (`github__merge_pull_request`
   * → "Merge a pull request"). Keyed by tool name. The web interface puts it
   * at the head of an approval request, before the resource the call resolves
   * to ("Merge a pull request · acme-org/app") : a person decides on what the
   * agent wants to do, not on the name of a permission. A tool without a
   * title is shown by its name. For people only : it is not part of
   * `tools/list` and the host decides nothing from it. Optional in the
   * contract ; every tool of a plugin shipped with the gateway has one
   * (structural test).
   */
  readonly toolTitles?: Readonly<Record<string, string>>;
  /**
   * Arguments whose values are secrets, by tool : the names of top-level
   * arguments of that tool (`fly__set_secrets` → `['values']`). The host never
   * shows such a value to a person : the approval view replaces each string it
   * holds — the argument itself, every value of an object, every item of a
   * list — with a short fingerprint, and keeps the keys (the secret names).
   * The call itself is unchanged. Each name must be a declared argument of
   * the tool (`definePlugin`). Absent : every argument is shown as it is.
   */
  readonly secretArguments?: Readonly<Record<string, readonly string[]>>;
  /** URL of the plugin's modelling handbook, when published. */
  readonly docsUrl?: string;
  /**
   * Tools whose effect cannot be bound to one resource (a free-text request to
   * the service's own agent, say), each with one sentence saying why. The host
   * makes them unavailable on an account that can reach a resource hosting
   * the gateway itself (`self_resources`): no mission resource check could keep
   * such a tool away from it (SEC 2026-10-15 re-check M-1). Keys are tool names
   * of the plugin.
   */
  readonly unboundTools?: Readonly<Record<string, string>>;

  /**
   * Tools of the service the plugin deliberately does not expose, each with
   * one sentence saying why (GitHub's workflow dispatch: it runs whatever the
   * workflow does, with the repository's secrets). Shown on the plugin's
   * public page next to "Anything else" (ADR plugin-contract-and-credential-spec,
   * amendment 2026-11-05). A name here is never a declared tool
   * (`definePlugin`), and `classify` keeps refusing it by name. Absent : the
   * plugin names no left-out tool.
   */
  readonly excludedTools?: Readonly<Record<string, string>>;

  /**
   * Representative calls of every tool, keyed by tool name : the samples the
   * test kit runs (`assertCatalogCoverage` defaults to them) and the site
   * classifies when it builds, so a page shows the slices the classifier
   * really emits. Each key is a tool of the plugin and each list is non-empty
   * (`definePlugin`); that every tool has one and every slice is covered is
   * the kit's check. Absent : the tests pass their own samples, and the page
   * shows no worked calls.
   */
  readonly examples?: ToolSamples;

  /**
   * The tools whose success creates a resource of the account : something
   * `discoverResources` returns as a new ref afterwards (`fly__create_app`
   * creates an app, and an app is what a Fly account lists). After such a
   * call succeeds through the execution door, the host runs the account's
   * discovery again, off the request path, so the new resource is known — and
   * reached by a mission issued on the whole account — at once (ADR
   * created-resources-join-the-mission). Each name is an MCP tool of the
   * plugin (`definePlugin`). A tool that creates something inside a resource
   * (a DNS record in a zone, a machine in an app) is not one. Absent : no call
   * of this plugin triggers a discovery. A plugin that declares it must
   * declare `createdResources` too (`definePlugin`).
   */
  readonly resourceCreatingTools?: readonly string[];

  /**
   * The instance as this service's git remote (spec vaubaan-gateway §4.1 ter) :
   * `git clone` / `git push` against
   * `https://<instance>/git/<service id>/<repository>.git` with the mission key
   * as the password, decided and audited like a tool call. Absent for a
   * service whose agents have no git to speak. Any number of plugins may
   * declare it : the path names the service (ADR
   * protocol-doors-belong-to-the-host).
   */
  readonly gitRemote?: GitRemoteCapability;

  /** The MCP tools the plugin exposes, named `<prefix>__<local>`. May be empty for a classifier-only plugin. */
  readonly tools: readonly McpToolDeclaration[];
  /** Declarative graph of the service's entities (risk-model spec §2). */
  readonly dataModel: DataModel;
  /** The risk catalog, loaded from `risk-catalog.yaml` at boot, macro-actions included. */
  readonly catalog: RiskCatalog;
  /**
   * How an account to this service is obtained, stored and refreshed :
   * the one way of connecting, the simplest the service offers — a token a
   * person makes by hand whenever the service has one, OAuth only where it
   * has none (ADR one-place-to-authorize-services-token-first).
   */
  readonly credential: CredentialSpec;

  /**
   * Classify a concrete call into the slices it touches. Pure : no IO, no
   * credential. `resources` are the mission's resources on this account,
   * so the classifier can derive the environment and refuse refs the
   * arguments do not identify. A call touching several entities returns
   * several slices. `account` carries the account's public form
   * fields (`ClassifyAccount`), so a slice can name what the account
   * is bound to (an organization) when no resource of the mission says it.
   */
  classify(
    tool: string,
    args: Readonly<Record<string, unknown>>,
    resources: readonly Resource[],
    account?: ClassifyAccount,
  ): ClassifyOutcome;

  /**
   * Execute an allowed call against the service. Throws
   * `UpstreamAuthError` when the service rejects the credential (the host
   * then tries `refresh`, and marks the account `expired` if that fails).
   */
  execute(
    ctx: ExecuteContext,
    tool: string,
    args: Readonly<Record<string, unknown>>,
  ): Promise<McpToolResult>;

  /**
   * List the resources reachable through a freshly connected credential
   * (repositories, projects, zones…). Called when the account is connected, on the
   * owner's "refresh resources", and after a call of one of
   * `resourceCreatingTools` succeeded. Returned refs are the ones `classify`
   * will see in `resources`.
   */
  discoverResources(ctx: AccountContext): Promise<readonly Resource[]>;

  /**
   * The resource(s) a successful call of one of `resourceCreatingTools`
   * created, read from the call's answer and described exactly as
   * `discoverResources` would describe them (same ref, display name and
   * metadata shape). Pure : no IO, no credential. The host calls it on the
   * request path, after an allowed call whose result is not `isError`, upserts
   * what it returns into the account's resources and adds it to the
   * mission that made the call, so the mission reaches what it created at once
   * (ADR created-resources-join-the-mission). The answer is untrusted : read
   * every ref through the grammar discovery uses, and return `[]` when the
   * answer cannot be read — the discovery that follows the call still runs.
   * `args` are the call's arguments, already classified and allowed.
   * Required when `resourceCreatingTools` is declared (`definePlugin`).
   */
  createdResources?(
    tool: string,
    args: Readonly<Record<string, unknown>>,
    result: McpToolResult,
  ): readonly Resource[];

  /**
   * Derive the environment a slice falls under when the service carries
   * it in the call itself rather than on the resource : the `env[<label>]`
   * segment for Vercel, the only shipped plugin that declares the hook
   * (spec vaubaan-gateway §0 "Resource"). Pure. Return `undefined` when the slice carries no
   * environment of its own ; the host then falls back to the owner's label
   * on the matching resource (`envResolverFor` in `@vaubaan/policy-engine`).
   * Return `NO_SINGLE_ENV` when the slice names its environment but not
   * exactly one (a wildcard, a list, a value outside the service's closed
   * set) : the host then resolves no environment at all and refuses every
   * env-scoped risk the slice touches — the label never stands in for a
   * slice that reaches several environments.
   * Absent when the environment always lives on the resource label
   * (Supabase, Railway, Stripe's per-mode resources). `envFromSliceSegment`
   * builds the common segment-lookup implementation.
   */
  envOf?(slice: Slice, resources: readonly Resource[]): ReturnType<EnvOf>;

  /**
   * Override of the credential refresh for a non-standard flow (a re-minted
   * installation token, a service whose refresh is not the RFC 6749
   * `refresh_token` grant). The host refreshes a standard `oauth2`
   * credential itself from the spec — `tokenUrl`, `clientAuthMethod`,
   * `resourceIndicator` — so a plugin whose service follows the standard
   * declares `refreshable: true` and nothing else. When present, the host
   * calls it instead of the generic refresh ; it returns a new
   * `CredentialSecret` and must not mutate its input.
   */
  refresh?(ctx: AccountContext): Promise<CredentialSecret>;

  /**
   * Withdraw at the service the grant this account holds, when the owner
   * revokes the account (spec vaubaan-gateway §2.3). For a service whose
   * revocation is not one of the declarative `OAuth2CredentialSpec.revocation`
   * shapes. The host calls it once, with the credential it is about to erase,
   * after the account is revoked locally : the local revocation never
   * depends on it. Resolve when the service confirmed ; throw otherwise
   * (the host then tells the person to remove the grant by hand). When
   * present it takes precedence over `credential.revocation`. No agent
   * argument ever reaches it.
   */
  revoke?(ctx: AccountContext): Promise<void>;

  /**
   * One or two plain sentences telling a person where, at the service, they
   * remove the grant themselves : shown when the gateway cannot withdraw it
   * (no `revoke`, no `credential.revocation`) or tried and was not answered.
   * Names the place in the service's interface ; no markup. Optional in the
   * contract ; every plugin shipped with the gateway fills it (structural
   * test).
   */
  readonly manualRevocation?: string;
}

/**
 * @deprecated Renamed `ServicePlugin` (ADR one-word-per-thing-account-service-plugin, R2);
 * kept for one minor so that a plugin pinned by an operator still compiles. Removed in 0.10.
 */
export type ProviderPlugin = ServicePlugin;
