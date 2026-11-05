/**
 * The arguments of the `axonaut` tools: one declaration per argument, from
 * which the JSON schema of `tools/list`, the classifier and the executor are
 * all derived.
 *
 * Handbook : docs/handbook/providers/axonaut.md ("Identifiers").
 *
 * `readArguments` is the one reader of a call: `readCall` (`call.ts`) runs it
 * for `classify` and for `execute` alike, and the request is built from what
 * it returned, never from `args`. A value outside its kind is refused, never
 * repaired: an id with a leading zero, a date in another format, a text with
 * a control character, a number that is not finite. An argument a tool does
 * not declare is never read, so it never reaches Axonaut (the executor builds
 * every request field by field).
 *
 * Identifiers (`id`): Axonaut ids are integers (its schemas declare
 * `company_id`, `invoice_id`… as `integer`, its paths as strings). The
 * grammar `axonautId` accepts a decimal string or a safe integer, without a
 * leading zero and at most 15 digits, so the value named in the slice, in the
 * path and (as a JSON number) in a body is the same number.
 */

import { isRecord } from '@vaubaan/plugin-sdk';

/** One Axonaut id: a decimal number, no sign, no leading zero, at most 15 digits. */
export const AXONAUT_ID = /^(0|[1-9][0-9]{0,14})$/;

/**
 * The value as an Axonaut id (its decimal string), or `null`. The one grammar
 * of every identifier of this plugin: the account ref, a record id in a path,
 * an id in a body or a filter. Shared by `classify`, `execute` and discovery.
 */
export function axonautId(value: unknown): string | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 && AXONAUT_ID.test(String(value))
      ? String(value)
      : null;
  }
  return typeof value === 'string' && AXONAUT_ID.test(value) ? value : null;
}

/** ISO 8601, as Axonaut's `date` schema asks: a day, or a day and a time with its offset. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(Z|[+-]\d{2}:\d{2}))?$/;
/** The `DD/MM/YYYY` dates of Axonaut's task schemas. */
const DAY_MONTH_YEAR = /^\d{2}\/\d{2}\/\d{4}$/;
/** One e-mail address, one value: no space, no list separator. */
const EMAIL = /^[^\s@,;<>"]+@[^\s@,;<>"]+$/;
// eslint-disable-next-line no-control-regex -- the point is to refuse control characters
const CONTROL = /[\u0000-\u001f\u007f]/;
// eslint-disable-next-line no-control-regex -- control characters other than tab and line breaks
const CONTROL_BUT_LINE_BREAKS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/** Product lines of a quotation or an invoice, at most this many per call. */
export const MAX_PRODUCT_LINES = 200;
/** The largest page number a list accepts (Axonaut's `page` header). */
export const MAX_PAGE = 10_000;

export type FieldKind =
  | { readonly kind: 'id' }
  | { readonly kind: 'line'; readonly max: number }
  | { readonly kind: 'text'; readonly max: number }
  | { readonly kind: 'email' }
  | { readonly kind: 'number'; readonly min: number; readonly max: number }
  | { readonly kind: 'integer'; readonly min: number; readonly max: number }
  | { readonly kind: 'boolean' }
  | { readonly kind: 'enum'; readonly values: readonly string[] }
  | { readonly kind: 'code'; readonly values: readonly number[] }
  | { readonly kind: 'iso-date' }
  | { readonly kind: 'day-month-year' }
  | { readonly kind: 'product-lines' };

export type Field = FieldKind & { readonly description: string };

/** The arguments a tool declares, by name. */
export type Fields = Readonly<Record<string, Field>>;

/** A product line as sent to Axonaut, built field by field. */
export interface ProductLine {
  readonly name: string;
  readonly price: number;
  readonly quantity: number;
  readonly tax_rate: number;
  readonly id?: number;
  readonly unit?: string;
  readonly description?: string;
  readonly discount_percent?: number;
}

export type FieldValue = string | number | boolean | readonly ProductLine[];

/** What `readArguments` read: only the declared arguments the call carries. */
export type Values = Readonly<Record<string, FieldValue>>;

// ─── Constructors used by `tools.ts` ─────────────────────────────────────

export const id = (description: string): Field => ({ kind: 'id', description });
export const line = (description: string, max = 255): Field => ({
  kind: 'line',
  max,
  description,
});
export const text = (description: string, max = 10_000): Field => ({
  kind: 'text',
  max,
  description,
});
export const email = (description: string): Field => ({ kind: 'email', description });
export const amount = (description: string): Field => ({
  kind: 'number',
  min: 0,
  max: 1e12,
  description,
});
export const percent = (description: string): Field => ({
  kind: 'number',
  min: 0,
  max: 100,
  description,
});
export const integer = (description: string, min: number, max: number): Field => ({
  kind: 'integer',
  min,
  max,
  description,
});
export const flag = (description: string): Field => ({ kind: 'boolean', description });
export const oneOf = (description: string, values: readonly string[]): Field => ({
  kind: 'enum',
  values,
  description,
});
export const code = (description: string, values: readonly number[]): Field => ({
  kind: 'code',
  values,
  description,
});
export const isoDate = (description: string): Field => ({ kind: 'iso-date', description });
export const dayMonthYear = (description: string): Field => ({
  kind: 'day-month-year',
  description,
});
export const productLines = (description: string): Field => ({
  kind: 'product-lines',
  description,
});
export const page: Field = integer(
  'Page of results, from 1 (Axonaut answers one page per call).',
  1,
  MAX_PAGE,
);

// ─── JSON schema ─────────────────────────────────────────────────────────

const PRODUCT_LINE_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'Name of the line.' },
    price: { type: 'number', description: 'Unit price before tax.' },
    quantity: { type: 'number' },
    tax_rate: { type: 'number', description: 'Tax rate in percent, such as 20.' },
    product_id: { type: 'string', description: 'Id of a catalog product, optional.' },
    unit: { type: 'string' },
    description: { type: 'string' },
    discount_percent: { type: 'number' },
  },
  required: ['name', 'price', 'quantity', 'tax_rate'],
};

/** The JSON schema of one argument, as `tools/list` shows it. */
export function schemaOf(field: Field): Record<string, unknown> {
  const description = { description: field.description };
  switch (field.kind) {
    case 'id':
      return { type: 'string', pattern: AXONAUT_ID.source, ...description };
    case 'line':
    case 'text':
      return { type: 'string', maxLength: field.max, ...description };
    case 'email':
      return { type: 'string', format: 'email', ...description };
    case 'number':
      return { type: 'number', minimum: field.min, maximum: field.max, ...description };
    case 'integer':
      return { type: 'integer', minimum: field.min, maximum: field.max, ...description };
    case 'boolean':
      return { type: 'boolean', ...description };
    case 'enum':
      return { type: 'string', enum: [...field.values], ...description };
    case 'code':
      return { type: 'integer', enum: [...field.values], ...description };
    case 'iso-date':
      return { type: 'string', pattern: ISO_DATE.source, ...description };
    case 'day-month-year':
      return { type: 'string', pattern: DAY_MONTH_YEAR.source, ...description };
    case 'product-lines':
      return {
        type: 'array',
        minItems: 1,
        maxItems: MAX_PRODUCT_LINES,
        items: PRODUCT_LINE_SCHEMA,
        ...description,
      };
  }
}

// ─── The reader ──────────────────────────────────────────────────────────

type Read<T = FieldValue> = { readonly value: T } | { readonly denied: string };

function textOf(name: string, value: unknown, max: number, multiline: boolean): Read<string> {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    return { denied: `${name}: expected a non-empty string of at most ${max} characters` };
  }
  if ((multiline ? CONTROL_BUT_LINE_BREAKS : CONTROL).test(value)) {
    return { denied: `${name}: control characters are not accepted` };
  }
  return { value };
}

function numberOf(
  name: string,
  value: unknown,
  min: number,
  max: number,
  whole: boolean,
): Read<number> {
  const ok =
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= min &&
    value <= max &&
    (!whole || Number.isInteger(value));
  return ok && typeof value === 'number'
    ? { value }
    : { denied: `${name}: expected ${whole ? 'an integer' : 'a number'} from ${min} to ${max}` };
}

function productLineOf(name: string, value: unknown): ProductLine | string {
  if (!isRecord(value)) return `${name}: expected an object`;
  const lineName = textOf(`${name}.name`, value.name, 255, false);
  if ('denied' in lineName) return lineName.denied;
  const price = numberOf(`${name}.price`, value.price, -1e12, 1e12, false);
  if ('denied' in price) return price.denied;
  const quantity = numberOf(`${name}.quantity`, value.quantity, -1e9, 1e9, false);
  if ('denied' in quantity) return quantity.denied;
  const taxRate = numberOf(`${name}.tax_rate`, value.tax_rate, 0, 100, false);
  if ('denied' in taxRate) return taxRate.denied;
  const out: {
    -readonly [K in keyof ProductLine]: ProductLine[K];
  } = {
    name: lineName.value,
    price: price.value,
    quantity: quantity.value,
    tax_rate: taxRate.value,
  };
  if (value.product_id !== undefined) {
    const productId = axonautId(value.product_id);
    if (productId === null) return `${name}.product_id: malformed Axonaut id`;
    out.id = Number(productId);
  }
  if (value.unit !== undefined) {
    const unit = textOf(`${name}.unit`, value.unit, 32, false);
    if ('denied' in unit) return unit.denied;
    out.unit = unit.value;
  }
  if (value.description !== undefined) {
    const description = textOf(`${name}.description`, value.description, 10_000, true);
    if ('denied' in description) return description.denied;
    out.description = description.value;
  }
  if (value.discount_percent !== undefined) {
    const discount = numberOf(`${name}.discount_percent`, value.discount_percent, 0, 100, false);
    if ('denied' in discount) return discount.denied;
    out.discount_percent = discount.value;
  }
  return out;
}

function productLinesOf(name: string, value: unknown): Read {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PRODUCT_LINES) {
    return { denied: `${name}: expected 1 to ${MAX_PRODUCT_LINES} product lines` };
  }
  const lines: ProductLine[] = [];
  for (const [index, item] of value.entries()) {
    const read = productLineOf(`${name}[${index}]`, item);
    if (typeof read === 'string') return { denied: read };
    lines.push(read);
  }
  return { value: lines };
}

function readField(name: string, field: Field, value: unknown): Read {
  switch (field.kind) {
    case 'id': {
      const read = axonautId(value);
      return read === null ? { denied: `${name}: malformed Axonaut id` } : { value: read };
    }
    case 'line':
      return textOf(name, value, field.max, false);
    case 'text':
      return textOf(name, value, field.max, true);
    case 'email':
      return typeof value === 'string' && value.length <= 254 && EMAIL.test(value)
        ? { value }
        : { denied: `${name}: expected one e-mail address` };
    case 'number':
      return numberOf(name, value, field.min, field.max, false);
    case 'integer':
      return numberOf(name, value, field.min, field.max, true);
    case 'boolean':
      return typeof value === 'boolean' ? { value } : { denied: `${name}: expected true or false` };
    case 'enum':
      return typeof value === 'string' && field.values.includes(value)
        ? { value }
        : { denied: `${name}: expected one of ${field.values.join(', ')}` };
    case 'code':
      return typeof value === 'number' && field.values.includes(value)
        ? { value }
        : { denied: `${name}: expected one of ${field.values.join(', ')}` };
    case 'iso-date':
      return typeof value === 'string' && ISO_DATE.test(value)
        ? { value }
        : {
            denied: `${name}: expected an ISO 8601 date (2026-11-05 or 2026-11-05T14:30:00+01:00)`,
          };
    case 'day-month-year':
      return typeof value === 'string' && DAY_MONTH_YEAR.test(value)
        ? { value }
        : { denied: `${name}: expected a date written DD/MM/YYYY` };
    case 'product-lines':
      return productLinesOf(name, value);
  }
}

/**
 * The declared arguments of a call, each read by its kind; `required` ones
 * must be present. An absent or `null` optional argument is left out. An
 * argument the tool does not declare is not read.
 */
export function readArguments(
  fields: Fields,
  required: readonly string[],
  args: Readonly<Record<string, unknown>>,
): { readonly values: Values } | { readonly denied: string } {
  const values: Record<string, FieldValue> = {};
  for (const [name, field] of Object.entries(fields)) {
    const raw = args[name];
    if (raw === undefined || raw === null) {
      if (required.includes(name)) return { denied: `${name}: missing` };
      continue;
    }
    const read = readField(name, field, raw);
    if ('denied' in read) return read;
    values[name] = read.value;
  }
  return { values };
}
