/**
 * Brands of the error classes the host recognises across copies of the SDK.
 *
 * ADR plugins-bundled-or-pinned-by-the-operator : a pinned plugin is a
 * self-contained bundle carrying its own copy of `@vaubaan/plugin-sdk` (and of
 * this package), so an error it throws is an instance of ITS class, never of
 * the host's, and `instanceof` answers `false`. Each class the host inspects
 * sets a brand in its constructor — a property keyed by
 * `Symbol.for('@vaubaan/plugin-sdk/<ClassName>')`, the same symbol in every
 * copy of the code of a process — and the host asks a guard
 * (`isUpstreamAuthError`…) that reads the brand and the fields it uses.
 *
 * The brand is not enumerable : it never reaches a log line or a JSON body.
 * Its key names the SDK because the SDK is the published contract; the
 * classes of this package are re-exported there.
 */

const BRAND_PREFIX = '@vaubaan/plugin-sdk/';

/** The symbol that brands an instance of the class `className`, in every copy of the code. */
export function errorBrand(className: string): symbol {
  return Symbol.for(`${BRAND_PREFIX}${className}`);
}

/** Marks `target` as an instance of `className` (called in the class's constructor). */
export function brandError(target: object, className: string): void {
  Object.defineProperty(target, errorBrand(className), {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
}

/** Whether `x` carries the brand of `className` and a string `message`, whatever copy made it. */
export function hasErrorBrand(
  x: unknown,
  className: string,
): x is Error & Record<PropertyKey, unknown> {
  if (typeof x !== 'object' || x === null) return false;
  const record = x as Record<PropertyKey, unknown>;
  return record[errorBrand(className)] === true && typeof record['message'] === 'string';
}
