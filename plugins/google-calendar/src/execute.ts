/**
 * Upstream calls of the `google-calendar` provider, and resource discovery.
 *
 * Spec     : docs/spec/vaubaan-gateway.md §2.4 — the credential arrives
 *            decrypted in the context, is used for one call, and is never
 *            returned.
 * Handbook : docs/handbook/providers/google-calendar.md §6.2, §6.3.
 * ADR      : docs/decisions/google-calendar-through-an-oauth-broker.md D4.
 *
 * Rules:
 *   - the call is read by `readCalendarCall`, the classifier's own reader:
 *     the upstream arguments are the ones it returned, never `args`;
 *   - `list_calendars` is answered from the mission's calendars;
 *   - every other tool is one `tools/call` to Google's Calendar MCP server
 *     with the access token the broker issued; Google's tool result is passed
 *     through (its `isError` included);
 *   - what Google answers is untrusted: discovery reads calendar ids through
 *     their grammar and keeps only what it recognises as a calendar.
 */

import {
  CredentialRefusal,
  UpstreamAuthError,
  expectCredentialKind,
  refusalResult,
  type ConnectionContext,
  type ExecuteContext,
  type McpToolContent,
  type McpToolResult,
  type Resource,
} from '@vaubaan/plugin-sdk';

import { readCalendarCall } from './call.ts';
import { calendarIdOf, calendarRefOf, parseAddress } from './identifiers.ts';
import { PROVIDER_ID, UPSTREAM_TOOL } from './identity.ts';
import { mcpRequest } from './mcp.ts';
import { UPSTREAM_TOOL_LIST, type UpstreamTool } from './tools.ts';

/** Discovery keeps at most this many calendars. */
export const MAX_DISCOVERED_CALENDARS = 250;
/** The largest page `list_calendars` gives (Google's reference: max 250). */
export const DISCOVERY_PAGE_SIZE = 250;
/** At most this many pages are asked for. */
const MAX_DISCOVERY_PAGES = 5;

/** Mail domains that are not a company's: their account's own domain is not taken as internal. */
const CONSUMER_DOMAINS: ReadonlySet<string> = new Set(['gmail.com', 'googlemail.com']);

/**
 * What a person reads when Google refuses its Calendar MCP server to an
 * account that has just authorized it (a `CredentialRefusal`, shown on the
 * account page). ⚠ That Google answers 403 then is assumed, not observed.
 */
export const MCP_SERVER_REFUSED =
  "Google refused its Calendar MCP server to this account. A Google Workspace administrator may have to allow the app or the Calendar MCP server for the organisation; then refresh the account's calendars.";

function tokenOf(ctx: ConnectionContext): string {
  return expectCredentialKind(PROVIDER_ID, ctx.credential, 'oauth2').accessToken;
}

export async function executeGoogleCalendar(
  ctx: ExecuteContext,
  tool: string,
  args: Readonly<Record<string, unknown>>,
): Promise<McpToolResult> {
  const read = readCalendarCall(tool, args, ctx.resources);
  if ('denied' in read) return refusalResult(read.denied);
  const { call } = read;
  if (call.kind === 'list-calendars') return listCalendarsResult(call.calendars);
  const result = await mcpRequest(ctx, tokenOf(ctx), 'tools/call', {
    name: call.upstream,
    arguments: call.arguments,
  });
  return toolResultOf(result);
}

/** `list_calendars`: the mission's calendars, as discovery described them. */
function listCalendarsResult(calendars: readonly Resource[]): McpToolResult {
  const listed = calendars.map((c) => ({
    calendar: c.ref,
    id: calendarIdOf(c.ref),
    name: c.displayName,
    primary: c.metadata?.primary === true,
    ...(typeof c.metadata?.access_role === 'string' ? { accessRole: c.metadata.access_role } : {}),
  }));
  return { content: [{ type: 'text', text: JSON.stringify({ calendars: listed }, null, 2) }] };
}

/** Google's tool result, passed through; a block of a type MCP clients may not know becomes its JSON. */
export function toolResultOf(result: unknown): McpToolResult {
  if (
    typeof result !== 'object' ||
    result === null ||
    !Array.isArray((result as Record<string, unknown>).content)
  ) {
    throw new Error(`${PROVIDER_ID}: the MCP server answered something that is not a tool result`);
  }
  const r = result as Record<string, unknown>;
  const content = (r.content as unknown[]).map(contentBlock);
  const structured = r.structuredContent;
  return {
    content,
    ...(typeof structured === 'object' && structured !== null && !Array.isArray(structured)
      ? { structuredContent: structured as Record<string, unknown> }
      : {}),
    ...(r.isError === true ? { isError: true } : {}),
  };
}

function contentBlock(block: unknown): McpToolContent {
  const b = (typeof block === 'object' && block !== null ? block : {}) as Record<string, unknown>;
  if (b.type === 'text' && typeof b.text === 'string') return { type: 'text', text: b.text };
  return { type: 'text', text: JSON.stringify(block) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Discovery
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The calendars of the account, from Google's `list_calendars`, page by page
 * while Google gives a `nextPageToken`. A calendar is an object whose `id` is
 * in the calendar grammar (`identifiers.ts`); Google's subscribed calendars
 * (holidays, birthdays: an id with `#`) are outside it and left out. Each
 * resource carries `primary`, `access_role`, `account_email` (the primary
 * calendar's id) and `internal_domains`, the list the classifier zones
 * invited people with, which the owner edits — seeded with the account's
 * domain unless it is a consumer one.
 *
 * Also compares Google's live `tools/list` with the plugin's model and logs
 * the differences (names only).
 */
export async function discoverGoogleCalendarResources(
  ctx: ConnectionContext,
): Promise<readonly Resource[]> {
  const token = tokenOf(ctx);
  const found = new Map<string, FoundCalendar>();
  let pageToken: string | null = null;
  for (let page = 0; page < MAX_DISCOVERY_PAGES; page++) {
    const answer = await listCalendars(ctx, token, pageToken);
    for (const calendar of calendarsIn(answer)) {
      if (!found.has(calendar.id)) found.set(calendar.id, calendar);
    }
    pageToken = nextPageTokenOf(answer);
    if (pageToken === null || found.size >= MAX_DISCOVERED_CALENDARS) break;
  }
  await reportDrift(ctx, token);
  return resourcesOf([...found.values()].slice(0, MAX_DISCOVERED_CALENDARS));
}

async function listCalendars(
  ctx: ConnectionContext,
  token: string,
  pageToken: string | null,
): Promise<McpToolResult> {
  let result: unknown;
  try {
    result = await mcpRequest(ctx, token, 'tools/call', {
      name: UPSTREAM_TOOL.listCalendars,
      arguments: { pageSize: DISCOVERY_PAGE_SIZE, ...(pageToken ? { pageToken } : {}) },
    });
  } catch (err) {
    if (err instanceof UpstreamAuthError && err.upstreamStatus === 403) {
      throw new CredentialRefusal(MCP_SERVER_REFUSED, 403);
    }
    throw err;
  }
  const answer = toolResultOf(result);
  if (answer.isError === true) {
    throw new Error(`${PROVIDER_ID}: ${UPSTREAM_TOOL.listCalendars} failed`);
  }
  return answer;
}

export interface FoundCalendar {
  readonly id: string;
  readonly name: string;
  readonly primary: boolean;
  readonly accessRole: string | null;
}

/** The JSON documents of a tool result: its structured content, and every text block that parses. */
function documentsOf(result: McpToolResult): unknown[] {
  const docs: unknown[] = [];
  if (result.structuredContent) docs.push(result.structuredContent);
  for (const block of result.content) {
    if (block.type !== 'text') continue;
    try {
      docs.push(JSON.parse(block.text));
    } catch {
      // Not JSON: nothing is read from free text.
    }
  }
  return docs;
}

/** The calendars an answer of `list_calendars` names, deduplicated, in order. */
export function calendarsIn(result: McpToolResult): FoundCalendar[] {
  const found = new Map<string, FoundCalendar>();
  const visit = (value: unknown, depth: number): void => {
    if (depth > 6 || typeof value !== 'object' || value === null) return;
    if (Array.isArray(value)) {
      value.forEach((v) => visit(v, depth + 1));
      return;
    }
    const calendar = calendarObject(value as Record<string, unknown>);
    if (calendar && !found.has(calendar.id)) found.set(calendar.id, calendar);
    Object.values(value).forEach((v) => visit(v, depth + 1));
  };
  for (const doc of documentsOf(result)) visit(doc, 0);
  return [...found.values()];
}

/** An object that describes a calendar: an `id` of the grammar and a name (`summary`). */
function calendarObject(o: Record<string, unknown>): FoundCalendar | null {
  if (typeof o.id !== 'string' || calendarRefOf(o.id) === null) return null;
  const name = [o.summaryOverride, o.summary, o.name].find(
    (v): v is string => typeof v === 'string' && v.trim() !== '',
  );
  if (name === undefined && o.primary !== true) return null;
  return {
    id: o.id,
    name: (name ?? o.id).trim().slice(0, 200),
    primary: o.primary === true,
    accessRole: typeof o.accessRole === 'string' ? o.accessRole.slice(0, 40) : null,
  };
}

function nextPageTokenOf(result: McpToolResult): string | null {
  for (const doc of documentsOf(result)) {
    if (typeof doc !== 'object' || doc === null) continue;
    const token = (doc as Record<string, unknown>).nextPageToken;
    if (typeof token === 'string' && token.length > 0 && token.length <= 512) return token;
  }
  return null;
}

/** The resources of the calendars found, with the facts the classifier zones by. */
export function resourcesOf(calendars: readonly FoundCalendar[]): Resource[] {
  const primary = calendars.find((c) => c.primary);
  const accountEmail = primary ? (parseAddress(primary.id)?.address ?? null) : null;
  const accountDomain = accountEmail?.split('@')[1] ?? null;
  const internal =
    accountDomain !== null && !CONSUMER_DOMAINS.has(accountDomain) ? [accountDomain] : [];
  const resources: Resource[] = [];
  for (const calendar of calendars) {
    const ref = calendarRefOf(calendar.id);
    if (ref === null) continue;
    resources.push({
      provider: PROVIDER_ID,
      ref,
      displayName: calendar.name,
      metadata: {
        primary: calendar.primary,
        ...(calendar.accessRole ? { access_role: calendar.accessRole } : {}),
        ...(accountEmail ? { account_email: accountEmail } : {}),
        internal_domains: internal,
      },
    });
  }
  return resources;
}

/** What differs between Google's live tool list and the plugin's model: names only. */
export interface ToolDrift {
  readonly gone: readonly string[];
  readonly unmodelled: readonly string[];
  readonly arguments: Readonly<Record<string, readonly string[]>>;
}

/** The drift between a live `tools/list` answer and the model. */
export function toolDrift(
  live: unknown,
  model: readonly UpstreamTool[] = UPSTREAM_TOOL_LIST.tools,
): ToolDrift {
  const listed = Array.isArray((live as { tools?: unknown } | null)?.tools)
    ? ((live as { tools: unknown[] }).tools.filter(
        (t) =>
          typeof t === 'object' && t !== null && typeof (t as { name?: unknown }).name === 'string',
      ) as { name: string; inputSchema?: { properties?: Record<string, unknown> } }[])
    : [];
  const liveByName = new Map(listed.map((t) => [t.name, t] as const));
  const modelByName = new Map(model.map((t) => [t.name, t] as const));
  const args: Record<string, string[]> = {};
  for (const tool of model) {
    const other = liveByName.get(tool.name);
    if (!other) continue;
    const mine = new Set(Object.keys(tool.inputSchema.properties));
    const theirs = new Set(Object.keys(other.inputSchema?.properties ?? {}));
    const diff = [
      ...[...theirs].filter((n) => !mine.has(n)).map((n) => `+${n}`),
      ...[...mine].filter((n) => !theirs.has(n)).map((n) => `-${n}`),
    ];
    if (diff.length > 0) args[tool.name] = diff;
  }
  return {
    gone: model.map((t) => t.name).filter((n) => !liveByName.has(n)),
    unmodelled: listed.map((t) => t.name).filter((n) => !modelByName.has(n)),
    arguments: args,
  };
}

async function reportDrift(ctx: ConnectionContext, token: string): Promise<void> {
  try {
    const drift = toolDrift(await mcpRequest(ctx, token, 'tools/list', {}));
    if (drift.gone.length + drift.unmodelled.length + Object.keys(drift.arguments).length > 0) {
      ctx.logger?.warn(
        "Google's Calendar MCP tools differ from the plugin's model; model them again (handbook providers/google-calendar §6.4)",
        { gone: drift.gone, unmodelled: drift.unmodelled, arguments: drift.arguments },
      );
    }
  } catch (err) {
    ctx.logger?.debug('tools/list of the Google Calendar MCP server not compared', {
      error_class: err instanceof Error ? err.name : typeof err,
    });
  }
}
