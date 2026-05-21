/**
 * ResourceKind contracts — spec §5.1.
 *
 * Three kindClasses live side-by-side:
 *   - `org`        → OrgResourceKind (read-only inventory of an org-level
 *                    cloud resource like `github-org`).
 *   - `project`    → ProjectResourceKind (project-scoped, e.g. `github-repo`).
 *   - `org-admin`  → OrgResourceAdminKind (privileged org-scoped, declares
 *                    which ProjectResourceKinds it provisions + rotates).
 *
 * RotationMethod follows spec §0.1: `self` | `admin-mediated` | `manual`.
 *
 * `metadataSchema` is declared as `unknown` here — implementations will
 * narrow it to a Zod schema in concrete kind packages. We keep the types
 * package zod-free in v1 init.
 */

export type KindClass = 'org' | 'project' | 'org-admin';

export type RotationMethod = 'self' | 'admin-mediated' | 'manual';

/**
 * Describes a single key inside a Resource's Access bundle (e.g.
 * `GITHUB_TOKEN`, `SUPABASE_SERVICE_ROLE_KEY`).
 */
export interface AccessKeySpec {
  /** Human-readable label shown in the UI when paste-then-seal happens. */
  readonly label: string;
  /** Short markdown blurb explaining what the value should be. */
  readonly description?: string;
  /** Whether this key is mandatory for the Resource to be considered active. */
  readonly required: boolean;
  /** Optional regex (string) the cleartext must match before sealing. */
  readonly pattern?: string;
}

/**
 * Fragment of an MCP `mcp.json` server block — emitted by kinds that have an
 * MCP integration (spec §6.6, §6.7). Shape kept loose intentionally; the
 * `mcp.json` schema is owned by the MCP spec, not by us.
 *
 * Two flavours coexist in the MCP ecosystem:
 *   - **stdio** servers — `{ command, args?, env? }` (e.g. the GitHub MCP
 *     docker image, the Supabase npx wrapper).
 *   - **HTTP remote** servers — `{ type: 'http', url }` (e.g. Vercel's
 *     OAuth-backed `https://mcp.vercel.com/`).
 *
 * `command` is therefore optional: stdio fragments set it, HTTP fragments
 * omit it. The catch-all index signature lets us pass through any
 * MCP-spec field the catalogue doesn't model yet (`type`, `url`, …).
 */
export interface McpServerFragment {
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly [extra: string]: unknown;
}

/**
 * A child Resource as seen by an admin kind during list/create/destroy ops
 * (spec §5.1, OrgResourceAdminKind).
 */
export interface ProviderChild {
  readonly providerRef: string;
  readonly name: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

/**
 * Base contract for every ResourceKind exposed by a CloudProvider.
 *
 * Implementations live in concrete provider packages (not shipped in v1
 * init) and must NOT cache cleartext credentials. Access values are passed
 * in transiently by the browser caller.
 */
export interface ResourceKind {
  /** Catalogue identifier, e.g. `github-org`, `github-repo`. */
  readonly id: string;

  /** CloudProvider string (`github` | `vercel` | `supabase-cloud` | …). */
  readonly provider: string;

  /** Which slot of the hierarchy this kind fills. See spec §2.1. */
  readonly kindClass: KindClass;

  /** Title shown in the "+ Add Resource" wizard. */
  readonly displayName: string;

  /**
   * Markdown displayed to guide the user through manual setup on the
   * Provider's dashboard (signup, PAT generation, etc.). Rendered raw.
   */
  readonly setupDocs: string;

  /** Map of `key → AccessKeySpec` describing the sealed bundle's schema. */
  readonly accessSchema: Readonly<Record<string, AccessKeySpec>>;

  /**
   * Schema for `resources.provider_metadata`. Concrete implementations
   * typically pass a Zod schema here. v1 init keeps this loose to avoid
   * pulling Zod into the types-only package.
   */
  readonly metadataSchema: unknown;

  /** How this kind rotates its Access. See spec §0.1. */
  readonly rotationMethod: RotationMethod;

  /**
   * Idempotent shell command executed inside a sandboxed Runner container
   * (spec §10). Exit 0 == healthy. Receives metadata + decrypted access
   * map. Must NOT echo cleartext.
   */
  healthTestCmd(metadata: unknown, access: Readonly<Record<string, string>>): string;

  /**
   * Fragment of `mcp.json` to embed for this Resource, or `null` if the
   * kind has no MCP integration.
   */
  mcpFragment?(metadata: unknown): McpServerFragment | null;

  /** Hosts the kind needs to reach (used for the mitmproxy egress allowlist). */
  egressHosts(metadata: unknown): readonly string[];

  /**
   * Only set when `rotationMethod === 'self'`. Performs a self-rotation
   * call to the Provider and returns the new cleartext value, which the
   * caller MUST immediately seal.
   */
  rotateSelf?(access: Readonly<Record<string, string>>, accessKey: string): Promise<string>;
}

/**
 * Privileged kind that can provision + rotate child ProjectResources.
 * Always `kindClass: 'org-admin'`. `manages` lists the IDs of the
 * ProjectResourceKinds it is responsible for.
 */
export interface OrgResourceAdminKind extends ResourceKind {
  readonly kindClass: 'org-admin';

  /** IDs of ProjectResourceKinds this admin can provision & rotate. */
  readonly manages: readonly string[];

  /** Inventory adoption — list everything already in place on the Provider. */
  listChildren(access: Readonly<Record<string, string>>): Promise<readonly ProviderChild[]>;

  /** Create a new child resource on the Provider. */
  createChild(access: Readonly<Record<string, string>>, spec: unknown): Promise<ProviderChild>;

  /** Destroy a child resource on the Provider (idempotent, 404 == success). */
  destroyChild(access: Readonly<Record<string, string>>, providerRef: string): Promise<void>;

  /**
   * Regenerate one Access key of a child Resource via this admin's creds.
   * Used when the child's `rotationMethod === 'admin-mediated'`.
   * Returns the new cleartext — caller seals immediately.
   */
  rotateChildAccess(
    access: Readonly<Record<string, string>>,
    childProviderRef: string,
    accessKey: string,
  ): Promise<string>;
}
