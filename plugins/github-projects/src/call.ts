/**
 * The one reader of a `github-projects` call, shared by `classify` and
 * `execute` : every identifier and every argument a request carries is read
 * here, by its grammar, into a checked call. `classify` prices the checked
 * call ; `execute` builds its request from it, field by field, never from
 * `args` (ADR plugin-identifiers-one-grammar-for-classify-and-execute).
 *
 * Handbook : docs/handbook/services/github-projects.md ("Identifiers").
 * Written from GitHub's REST reference, "REST API endpoints for Projects"
 * (projects, fields, items, drafts, views), organization endpoints, read
 * 2026-11-16.
 */

import type { Resource } from '@vaubaan/plugin-sdk';

import { EXCLUDED_TOOL, SERVICE_ID, TOOL } from './identity.ts';

// ─── grammars ──────────────────────────────────────────────────────────────

/** An organization login : GitHub's grammar, alphanumerics and inner hyphens, 1 to 39. */
const ORG = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
/** A positive decimal integer, as GitHub numbers projects, items, fields and views. */
const DIGITS = /^[1-9][0-9]{0,15}$/;

/** The account's one project, `<org>/<number>` : its resource ref. */
export interface ProjectTarget {
  readonly org: string;
  readonly number: number;
  /** `<org>/<number>`, the resource ref and the slice identifier. */
  readonly ref: string;
}

/** The organization login, or `null`. */
export function orgLogin(value: unknown): string | null {
  return typeof value === 'string' && ORG.test(value) ? value : null;
}

/**
 * A positive integer id, given as a JSON number or as its decimal digits
 * (agents copy ids from answers either way), or `null`. Never a sign, a
 * fraction, a leading zero, a space or anything a URL could read twice.
 */
export function positiveId(value: unknown): number | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? value : null;
  if (typeof value !== 'string' || !DIGITS.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}

/** `<org>/<number>` read by the two grammars above, or `null`. */
export function projectRef(value: unknown): ProjectTarget | null {
  if (typeof value !== 'string') return null;
  const slash = value.indexOf('/');
  if (slash < 0) return null;
  const org = orgLogin(value.slice(0, slash));
  const raw = value.slice(slash + 1);
  const number = DIGITS.test(raw) ? positiveId(raw) : null;
  if (org === null || number === null) return null;
  return { org, number, ref: `${org}/${number}` };
}

// ─── bounds ────────────────────────────────────────────────────────────────

export const MAX_PER_PAGE = 100;
export const MAX_CURSOR_LENGTH = 512;
export const MAX_QUERY_LENGTH = 1024;
export const MAX_TITLE_LENGTH = 256;
export const MAX_BODY_LENGTH = 65536;
export const MAX_FIELDS_PER_CALL = 50;
export const MAX_VALUE_LENGTH = 1024;
export const MAX_NAME_LENGTH = 256;
export const MAX_OPTIONS = 50;
export const MAX_ITERATIONS = 50;
export const MAX_ITERATION_DAYS = 365;

/** A string of 1 to `max` characters, no control character, or `null`. */
function boundedText(value: unknown, max: number): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) return null;
  // eslint-disable-next-line no-control-regex -- the rule is the point : no control characters
  return /[\u0000-\u001f\u007f]/.test(value) ? null : value;
}

/** A free text (a body) of up to `max` characters ; line breaks and tabs allowed. */
function freeText(value: unknown, max: number): string | null {
  if (typeof value !== 'string' || value.length > max) return null;
  // eslint-disable-next-line no-control-regex -- control characters but \t \n \r
  return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) ? null : value;
}

/** `YYYY-MM-DD`, a real calendar day, or `null`. */
export function isoDate(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const at = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(at.getTime()) && at.toISOString().startsWith(value) ? value : null;
}

// ─── the checked call ──────────────────────────────────────────────────────

export interface Page {
  readonly perPage?: number;
  readonly after?: string;
  readonly before?: string;
}

/** One field value written on an item : text, number, date, option or iteration id, or `null` to clear. */
export interface FieldValue {
  readonly id: number;
  readonly value: string | number | null;
}

export type ItemContent =
  | { readonly type: 'Issue' | 'PullRequest'; readonly id: number }
  | {
      readonly type: 'Issue' | 'PullRequest';
      readonly owner: string;
      readonly repo: string;
      readonly number: number;
    };

export interface SelectOption {
  readonly name: string;
  readonly color: string;
  readonly description: string;
}

export interface Iteration {
  readonly title: string;
  readonly startDate: string;
  readonly duration: number;
}

export type NewField =
  | { readonly dataType: 'text' | 'number' | 'date'; readonly name: string }
  | {
      readonly dataType: 'single_select';
      readonly name: string;
      readonly options: readonly SelectOption[];
    }
  | {
      readonly dataType: 'iteration';
      readonly name: string;
      readonly startDate: string;
      readonly duration: number;
      readonly iterations: readonly Iteration[];
    };

export interface NewView {
  readonly name: string;
  readonly layout: 'table' | 'board' | 'roadmap';
  readonly filter?: string;
  readonly visibleFields?: readonly number[];
  readonly sortBy?: readonly (readonly [number, 'asc' | 'desc'])[];
  readonly groupBy?: readonly number[];
  readonly verticalGroupBy?: readonly number[];
}

export type ProjectCall = { readonly project: ProjectTarget } & (
  | { readonly kind: 'get-project' }
  | { readonly kind: 'list-fields'; readonly page: Page }
  | { readonly kind: 'get-field'; readonly fieldId: number }
  | {
      readonly kind: 'list-items';
      readonly page: Page;
      readonly q?: string;
      readonly fields: readonly number[];
    }
  | { readonly kind: 'get-item'; readonly itemId: number; readonly fields: readonly number[] }
  | {
      readonly kind: 'list-view-items';
      readonly viewNumber: number;
      readonly page: Page;
      readonly fields: readonly number[];
    }
  | { readonly kind: 'add-item'; readonly content: ItemContent }
  | { readonly kind: 'add-draft'; readonly title: string; readonly body?: string }
  | {
      readonly kind: 'update-item';
      readonly itemId: number;
      readonly values: readonly FieldValue[];
    }
  | { readonly kind: 'delete-item'; readonly itemId: number }
  | { readonly kind: 'create-field'; readonly field: NewField }
  | { readonly kind: 'create-view'; readonly view: NewView }
);

type Args = Readonly<Record<string, unknown>>;
type Read<T> = T | { readonly denied: string };

function isDenied<T>(read: Read<T>): read is { readonly denied: string } {
  return typeof read === 'object' && read !== null && 'denied' in read;
}

// ─── refusal sentences, shared with the tests ──────────────────────────────

export const MALFORMED_ITEM_ID = 'item_id: missing or not a positive integer';
export const MALFORMED_FIELD_ID = 'field_id: missing or not a positive integer';
export const MALFORMED_VIEW_NUMBER = 'view_number: missing or not a positive integer';
export const MALFORMED_PROJECT = "project: not '<organization>/<project number>'";
export const EXCLUDED_LIST_PROJECTS =
  'list_projects reads every project of the organization; this account is one project: call get_project.';

// ─── the project ───────────────────────────────────────────────────────────

/** The `github-projects` resources of the mission. */
function ownProjects(resources: readonly Resource[]): Resource[] {
  return resources.filter((r) => r.service === SERVICE_ID);
}

/**
 * The project a call targets : `args.project` when given, which must read as
 * `<org>/<number>` and be one of the mission's projects (never the single
 * project as a silent substitute) ; absent, the mission's single project.
 */
export function resolveProject(args: Args, resources: readonly Resource[]): Read<ProjectTarget> {
  const own = ownProjects(resources);
  if (args.project !== undefined) {
    const named = projectRef(args.project);
    if (named === null) return { denied: MALFORMED_PROJECT };
    return own.some((r) => r.ref === named.ref)
      ? named
      : { denied: `project '${named.ref}' is not selected in this mission` };
  }
  if (own.length === 1) {
    const single = projectRef(own[0]!.ref);
    return single ?? { denied: `the mission's project '${own[0]!.ref}' is not a project ref` };
  }
  return {
    denied:
      own.length === 0
        ? 'project: argument missing and the mission holds no GitHub project'
        : `project: argument missing and the mission holds ${own.length} projects — name one`,
  };
}

// ─── arguments ─────────────────────────────────────────────────────────────

function readPage(args: Args): Read<Page> {
  const page: { perPage?: number; after?: string; before?: string } = {};
  if (args.per_page !== undefined) {
    const n = positiveId(args.per_page);
    if (n === null || n > MAX_PER_PAGE) {
      return { denied: `per_page: an integer from 1 to ${MAX_PER_PAGE}` };
    }
    page.perPage = n;
  }
  for (const key of ['after', 'before'] as const) {
    if (args[key] === undefined) continue;
    const cursor = boundedText(args[key], MAX_CURSOR_LENGTH);
    if (cursor === null) return { denied: `${key}: a cursor from a previous page` };
    page[key] = cursor;
  }
  if (page.after !== undefined && page.before !== undefined) {
    return { denied: 'after and before: give one cursor, not both' };
  }
  return page;
}

/** `fields` of a read : the field ids whose values the answer carries. */
function readFieldIds(value: unknown, what: string): Read<readonly number[]> {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_FIELDS_PER_CALL) {
    return { denied: `${what}: up to ${MAX_FIELDS_PER_CALL} field ids` };
  }
  const ids: number[] = [];
  for (const raw of value) {
    const id = positiveId(raw);
    if (id === null) return { denied: `${what}: every field id is a positive integer` };
    ids.push(id);
  }
  return ids;
}

function readValues(value: unknown): Read<readonly FieldValue[]> {
  const shape = `fields: 1 to ${MAX_FIELDS_PER_CALL} entries { id, value }, value a string, a number or null, each field once`;
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_FIELDS_PER_CALL) {
    return { denied: shape };
  }
  const values: FieldValue[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry))
      return { denied: shape };
    const e = entry as Record<string, unknown>;
    const id = positiveId(e.id);
    if (id === null || !('value' in e) || values.some((v) => v.id === id)) return { denied: shape };
    const v = e.value;
    if (v === null || (typeof v === 'number' && Number.isFinite(v))) {
      values.push({ id, value: v });
    } else if (typeof v === 'string' && boundedText(v, MAX_VALUE_LENGTH) !== null) {
      values.push({ id, value: v });
    } else {
      return { denied: shape };
    }
  }
  return values;
}

/** Owner and repository names, GitHub's grammar (as the GitHub plugin's `call.ts`). */
const OWNER = /^[A-Za-z0-9_-]{1,39}$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;

function readContent(args: Args): Read<ItemContent> {
  const type = args.type;
  if (type !== 'Issue' && type !== 'PullRequest') {
    return { denied: "type: 'Issue' or 'PullRequest'" };
  }
  const byRepo = args.owner !== undefined || args.repo !== undefined || args.number !== undefined;
  if (args.content_id !== undefined) {
    if (byRepo) return { denied: 'content_id, or owner + repo + number: not both' };
    const id = positiveId(args.content_id);
    return id === null ? { denied: 'content_id: a positive integer' } : { type, id };
  }
  const owner = typeof args.owner === 'string' && OWNER.test(args.owner) ? args.owner : null;
  const repo =
    typeof args.repo === 'string' && REPO.test(args.repo) && !/^\.+$/.test(args.repo)
      ? args.repo
      : null;
  const number = positiveId(args.number);
  if (owner === null || repo === null || number === null) {
    return { denied: 'owner + repo + number of the issue or pull request (or content_id)' };
  }
  return { type, owner, repo, number };
}

const COLORS = ['GRAY', 'BLUE', 'GREEN', 'YELLOW', 'ORANGE', 'RED', 'PINK', 'PURPLE'] as const;
const DATA_TYPES = ['text', 'number', 'date', 'single_select', 'iteration'] as const;

function readNewField(args: Args): Read<NewField> {
  const name = boundedText(args.name, MAX_NAME_LENGTH);
  if (name === null) return { denied: `name: 1 to ${MAX_NAME_LENGTH} characters` };
  const dataType = DATA_TYPES.find((t) => t === args.data_type);
  if (dataType === undefined) return { denied: `data_type: one of ${DATA_TYPES.join(', ')}` };
  const optionsGiven = args.single_select_options !== undefined;
  const iterationGiven = args.iteration_configuration !== undefined;
  if (dataType === 'single_select') {
    if (iterationGiven) return { denied: 'iteration_configuration: only for an iteration field' };
    const shape = `single_select_options: 1 to ${MAX_OPTIONS} entries { name, color (${COLORS.join(', ')}), description }`;
    const raw = args.single_select_options;
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_OPTIONS)
      return { denied: shape };
    const options: SelectOption[] = [];
    for (const o of raw) {
      if (typeof o !== 'object' || o === null || Array.isArray(o)) return { denied: shape };
      const r = o as Record<string, unknown>;
      const optName = boundedText(r.name, MAX_NAME_LENGTH);
      const color = COLORS.find((c) => c === r.color);
      const description =
        r.description === undefined ? '' : freeText(r.description, MAX_VALUE_LENGTH);
      if (optName === null || color === undefined || description === null) return { denied: shape };
      options.push({ name: optName, color, description });
    }
    return { dataType, name, options };
  }
  if (optionsGiven) return { denied: 'single_select_options: only for a single_select field' };
  if (dataType === 'iteration') {
    const shape = `iteration_configuration: { start_date YYYY-MM-DD, duration 1-${MAX_ITERATION_DAYS} days, iterations?: up to ${MAX_ITERATIONS} { title, start_date, duration } }`;
    const raw = args.iteration_configuration;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { denied: shape };
    const c = raw as Record<string, unknown>;
    const startDate = isoDate(c.start_date);
    const duration = days(c.duration);
    if (startDate === null || duration === null) return { denied: shape };
    const iterations: Iteration[] = [];
    if (c.iterations !== undefined) {
      if (!Array.isArray(c.iterations) || c.iterations.length > MAX_ITERATIONS)
        return { denied: shape };
      for (const it of c.iterations) {
        if (typeof it !== 'object' || it === null || Array.isArray(it)) return { denied: shape };
        const i = it as Record<string, unknown>;
        const title = boundedText(i.title, MAX_NAME_LENGTH);
        const start = isoDate(i.start_date);
        const d = days(i.duration);
        if (title === null || start === null || d === null) return { denied: shape };
        iterations.push({ title, startDate: start, duration: d });
      }
    }
    return { dataType, name, startDate, duration, iterations };
  }
  if (iterationGiven) return { denied: 'iteration_configuration: only for an iteration field' };
  return { dataType, name };
}

function days(value: unknown): number | null {
  const n = positiveId(value);
  return n !== null && n <= MAX_ITERATION_DAYS ? n : null;
}

const LAYOUTS = ['table', 'board', 'roadmap'] as const;

function readNewView(args: Args): Read<NewView> {
  const name = boundedText(args.name, MAX_NAME_LENGTH);
  if (name === null) return { denied: `name: 1 to ${MAX_NAME_LENGTH} characters` };
  const layout = LAYOUTS.find((l) => l === args.layout);
  if (layout === undefined) return { denied: `layout: one of ${LAYOUTS.join(', ')}` };
  const view: {
    name: string;
    layout: NewView['layout'];
    filter?: string;
    visibleFields?: readonly number[];
    sortBy?: readonly (readonly [number, 'asc' | 'desc'])[];
    groupBy?: readonly number[];
    verticalGroupBy?: readonly number[];
  } = { name, layout };
  if (args.filter !== undefined) {
    const filter = boundedText(args.filter, MAX_QUERY_LENGTH);
    if (filter === null) return { denied: `filter: 1 to ${MAX_QUERY_LENGTH} characters` };
    view.filter = filter;
  }
  if (args.visible_fields !== undefined) {
    if (layout === 'roadmap') return { denied: 'visible_fields: not for a roadmap view' };
    const ids = readFieldIds(args.visible_fields, 'visible_fields');
    if (isDenied(ids)) return ids;
    view.visibleFields = ids;
  }
  if (args.sort_by !== undefined) {
    const shape = `sort_by: up to ${MAX_FIELDS_PER_CALL} pairs [field id, 'asc' | 'desc']`;
    if (!Array.isArray(args.sort_by) || args.sort_by.length > MAX_FIELDS_PER_CALL) {
      return { denied: shape };
    }
    const pairs: (readonly [number, 'asc' | 'desc'])[] = [];
    for (const p of args.sort_by as unknown[]) {
      if (!Array.isArray(p) || p.length !== 2) return { denied: shape };
      const [rawId, rawDir] = p as [unknown, unknown];
      const id = positiveId(rawId);
      const dir = rawDir === 'asc' || rawDir === 'desc' ? rawDir : null;
      if (id === null || dir === null) return { denied: shape };
      pairs.push([id, dir]);
    }
    view.sortBy = pairs;
  }
  for (const [key, prop] of [
    ['group_by', 'groupBy'],
    ['vertical_group_by', 'verticalGroupBy'],
  ] as const) {
    if (args[key] === undefined) continue;
    const ids = readFieldIds(args[key], key);
    if (isDenied(ids)) return ids;
    if (ids.length !== 1) return { denied: `${key}: exactly one field id` };
    view[prop] = ids;
  }
  return view;
}

// ─── the reader ────────────────────────────────────────────────────────────

/**
 * The checked call, or the sentence refusing it. Pure : no IO, no clock.
 * `classify` and `execute` both call it, so what is priced is what is sent.
 */
export function readProjectCall(
  tool: string,
  args: Args,
  resources: readonly Resource[],
): Read<ProjectCall> {
  if (tool === EXCLUDED_TOOL.listProjects) return { denied: EXCLUDED_LIST_PROJECTS };
  if (!(Object.values(TOOL) as string[]).includes(tool))
    return { denied: `unknown tool '${tool}'` };
  const project = resolveProject(args, resources);
  if (isDenied(project)) return project;

  switch (tool) {
    case TOOL.getProject:
      return { project, kind: 'get-project' };
    case TOOL.listProjectFields: {
      const page = readPage(args);
      return isDenied(page) ? page : { project, kind: 'list-fields', page };
    }
    case TOOL.getProjectField: {
      const fieldId = positiveId(args.field_id);
      return fieldId === null
        ? { denied: MALFORMED_FIELD_ID }
        : { project, kind: 'get-field', fieldId };
    }
    case TOOL.listProjectItems: {
      const page = readPage(args);
      if (isDenied(page)) return page;
      const fields = readFieldIds(args.fields, 'fields');
      if (isDenied(fields)) return fields;
      if (args.q === undefined) return { project, kind: 'list-items', page, fields };
      const q = boundedText(args.q, MAX_QUERY_LENGTH);
      if (q === null) return { denied: `q: 1 to ${MAX_QUERY_LENGTH} characters` };
      return { project, kind: 'list-items', page, fields, q };
    }
    case TOOL.getProjectItem: {
      const itemId = positiveId(args.item_id);
      if (itemId === null) return { denied: MALFORMED_ITEM_ID };
      const fields = readFieldIds(args.fields, 'fields');
      return isDenied(fields) ? fields : { project, kind: 'get-item', itemId, fields };
    }
    case TOOL.listProjectViewItems: {
      const viewNumber = positiveId(args.view_number);
      if (viewNumber === null) return { denied: MALFORMED_VIEW_NUMBER };
      const page = readPage(args);
      if (isDenied(page)) return page;
      const fields = readFieldIds(args.fields, 'fields');
      return isDenied(fields)
        ? fields
        : { project, kind: 'list-view-items', viewNumber, page, fields };
    }
    case TOOL.addProjectItem: {
      const content = readContent(args);
      return isDenied(content) ? content : { project, kind: 'add-item', content };
    }
    case TOOL.addProjectDraft: {
      const title = boundedText(args.title, MAX_TITLE_LENGTH);
      if (title === null) return { denied: `title: 1 to ${MAX_TITLE_LENGTH} characters` };
      if (args.body === undefined) return { project, kind: 'add-draft', title };
      const body = freeText(args.body, MAX_BODY_LENGTH);
      if (body === null) return { denied: `body: up to ${MAX_BODY_LENGTH} characters` };
      return { project, kind: 'add-draft', title, body };
    }
    case TOOL.updateProjectItem: {
      const itemId = positiveId(args.item_id);
      if (itemId === null) return { denied: MALFORMED_ITEM_ID };
      const values = readValues(args.fields);
      return isDenied(values) ? values : { project, kind: 'update-item', itemId, values };
    }
    case TOOL.deleteProjectItem: {
      const itemId = positiveId(args.item_id);
      return itemId === null
        ? { denied: MALFORMED_ITEM_ID }
        : { project, kind: 'delete-item', itemId };
    }
    case TOOL.createProjectField: {
      const field = readNewField(args);
      return isDenied(field) ? field : { project, kind: 'create-field', field };
    }
    case TOOL.createProjectView: {
      const view = readNewView(args);
      return isDenied(view) ? view : { project, kind: 'create-view', view };
    }
    default:
      return { denied: `unknown tool '${tool}'` };
  }
}

export { isDenied };
