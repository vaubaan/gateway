/**
 * The shape a credential field expects, said in words before the person types
 * (style guide §5 "Form field"). A plugin declares the shape as a regular
 * expression (`CredentialField.pattern`); this reads the simple, common forms
 * of one — a literal prefix or a choice of prefixes, digits only, a minimum
 * length — and says them: "starts with sk_test_ or rk_test_", "20 characters or
 * more", "digits only".
 *
 * A mechanical reading: nothing is said that the pattern does not say, and a
 * pattern in any other form gives `null` (the field then shows the plugin's own
 * hint alone). Pure and browser-safe.
 */

/** Characters of a prefix a person can read and type as they are. */
const LITERAL = /^[A-Za-z0-9_-]+/;
/** `(sk|rk)`: a choice between literal alternatives. */
const CHOICE = /^\(([A-Za-z0-9_-]+(?:\|[A-Za-z0-9_-]+)+)\)/;
/** A character class with its quantifier, up to the end of the pattern. */
const CLASS_TAIL = /^\[[^\]]+\](\+|\*|\{(\d+)(,(\d*))?\})?\$$/;

function joinOr(words: readonly string[]): string {
  if (words.length <= 1) return words[0] ?? '';
  return `${words.slice(0, -1).join(', ')} or ${words[words.length - 1]}`;
}

/** The literal prefixes a `^…` pattern starts with, and what follows them. */
function leadingPrefixes(body: string): { prefixes: string[]; rest: string } {
  let prefixes = [''];
  let rest = body;
  for (;;) {
    const choice = CHOICE.exec(rest);
    if (choice?.[1]) {
      const options = choice[1].split('|');
      prefixes = prefixes.flatMap((prefix) => options.map((option) => `${prefix}${option}`));
      rest = rest.slice(choice[0].length);
      continue;
    }
    const literal = LITERAL.exec(rest);
    if (literal) {
      prefixes = prefixes.map((prefix) => `${prefix}${literal[0]}`);
      rest = rest.slice(literal[0].length);
      continue;
    }
    break;
  }
  return { prefixes: prefixes.filter((prefix) => prefix !== ''), rest };
}

export function shapeOfPattern(pattern: string | undefined): string | null {
  if (!pattern || !pattern.startsWith('^') || !pattern.endsWith('$')) return null;
  const body = pattern.slice(1);
  if (body === '[0-9]+$' || body === '\\d+$') return 'digits only';
  const { prefixes, rest } = leadingPrefixes(body);
  const tail = CLASS_TAIL.exec(rest);
  if (!tail) return null;
  const words: string[] = [];
  if (prefixes.length > 0) words.push(`starts with ${joinOr(prefixes)}`);
  const [, quantifier, minimum, range, maximum] = tail;
  if (quantifier?.startsWith('{') && minimum) {
    const min = Number(minimum);
    if (range === undefined) words.push(`${min} characters`);
    else if (!maximum) words.push(`${min} characters or more`);
    else words.push(`${min} to ${Number(maximum)} characters`);
  }
  return words.length > 0 ? words.join(', ') : null;
}
