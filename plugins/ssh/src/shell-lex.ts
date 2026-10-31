/**
 * Lexer of the `ssh` provider : a POSIX shell line → simple commands made of
 * words and redirections, the way `sh` / `bash` tokenise it.
 *
 * Spec     : docs/spec/gateway-risk-model.md §7 (a classification error is a
 *            security hole).
 * Handbook : docs/handbook/providers/ssh.md, Invariants, "Fail-closed rule".
 *
 * Pure. This is not a shell : it models only what it can model exactly —
 * single and double quotes, backslash escapes, line continuations, comments,
 * the control operators, plain redirections, `$name` / `${name}` expansions —
 * and **names everything else as opaque** instead of guessing. A line that is
 * opaque is never a read and carries every write class (`command/profile.ts`),
 * so a disagreement between this lexer and the remote shell on an opaque
 * construct cannot lower a classification.
 *
 * Opaque constructs : a control character other than tab and newline, ANSI-C
 * or locale quoting (`$'…'`, `$"…"`), a command or process substitution
 * (`$(…)`, backticks, `<(…)`, `>(…)`, `$[…]`), a here-document or here-string
 * (`<<`, `<<<`), a `${…}` whose body is more than a name and a plain operator,
 * a descriptor redirection that is not exactly `>&N` / `<&N` / `>&-`
 * (`<&word`, `>&2file`, `>&--rf`), a backslash-newline
 * glued to a token or inside double quotes, an unterminated quote, a trailing
 * backslash, a redirection without a target.
 *
 * Checked against `bash` with a differential fuzzer (random lines over the
 * shell's special characters, a `command_not_found_handle` recording each
 * argv) : every command bash ran on a line that is not opaque was seen here
 * with the same argument vector.
 */

/** One shell word after quote removal. */
export interface Word {
  /** The text the command receives, quotes and escapes removed ; expansions are kept verbatim (`$HOME`). */
  readonly value: string;
  /** One flag per character of `value` : true when the shell may still interpret it (not quoted, not escaped). */
  readonly bare: readonly boolean[];
  /** The word contains a `$name` / `${name}` expansion (outside single quotes). */
  readonly expansion: boolean;
}

export interface Redirect {
  /** `in` : `< file`. `out` : `> file`, `>> file`, `>| file`, `&> file`, `>& file`, `<> file`. */
  readonly kind: 'in' | 'out';
  readonly target: Word;
}

export interface SimpleCommand {
  /** The source text of the command, trimmed, comments removed. */
  readonly text: string;
  readonly words: readonly Word[];
  readonly redirects: readonly Redirect[];
}

export interface LexedLine {
  /** Simple commands in order ; empty ones are dropped. */
  readonly commands: readonly SimpleCommand[];
  /** `$(`, backtick, `<(`, `>(` or `$[` seen outside single quotes. */
  readonly substitution: boolean;
  /** An output redirection to a file was seen. */
  readonly redirection: boolean;
  /** A quote or a `${` was left open, a backslash ends the line, or a redirection has no target. */
  readonly malformed: boolean;
  /** Why the line cannot be seen through ; empty when it can. Includes `substitution` and `malformed`. */
  readonly opaque: readonly string[];
}

/** Every C0 control character but tab and newline, plus DEL. A shell does not treat them as blanks. */
function hasControlCharacter(line: string): boolean {
  for (let k = 0; k < line.length; k += 1) {
    const code = line.charCodeAt(k);
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a) || code === 0x7f) return true;
  }
  return false;
}

/** `>&1`, `<&3`, `>&-` : a descriptor duplication only when the descriptor is the whole word. */
const FD_DUPLICATION = /[<>]&(?:\d+|-)(?=$|[\s;|&<>()])/y;
/** `$name`, `$1`, `$?` … */
const SIMPLE_EXPANSION = /\$(?:[A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-])/y;
/** What a `${…}` body may hold to stay a plain expansion : a name and the operators `:-`, `#`, `%`, `/` on literal text. */
const PLAIN_EXPANSION_BODY = /^[A-Za-z0-9_@*#?!:=+%/.,^~-]*$/;

/**
 * Is one of `chars` present in the word where the shell still interprets it ?
 * `bare` holds one flag per UTF-16 unit of `value`, so the word is walked by
 * unit, never by code point : after a character outside the BMP the two
 * indexes differ, and a quoted emoji must not lend its flag to what follows.
 */
function hasBare(word: Word, chars: string): boolean {
  for (let i = 0; i < word.value.length; i += 1) {
    if (word.bare[i] === true && chars.includes(word.value[i]!)) return true;
  }
  return false;
}

/** Does the word hold a glob character the shell would expand ? */
export function hasGlob(word: Word): boolean {
  return hasBare(word, '*?[');
}

/**
 * Does the word hold a brace the shell may expand ? `{}` (the `find` / `xargs`
 * placeholder) and the lone `{` / `}` of a command group are not expansions.
 */
export function hasBrace(word: Word): boolean {
  if (word.value === '{}' || word.value === '{' || word.value === '}') return false;
  return hasBare(word, '{}');
}

/** True when the value the command receives is not the text of the word : expansion, glob or brace. */
export function isDynamic(word: Word): boolean {
  return word.expansion || hasGlob(word) || hasBrace(word);
}

/** Tokenise one command line. Never throws ; what it cannot model is reported in `opaque`. */
export function lexCommandLine(line: string): LexedLine {
  const commands: SimpleCommand[] = [];
  const opaque = new Set<string>();
  let substitution = false;
  let redirection = false;
  let malformed = false;

  // The command being built.
  let text = '';
  let words: Word[] = [];
  let redirects: Redirect[] = [];
  let pending: Redirect['kind'] | null = null;

  // The word being built.
  let value = '';
  let bare: boolean[] = [];
  let expansion = false;
  let open = false;
  /** No quote, escape or expansion took part in the word so far. */
  let plain = true;

  let i = 0;
  const end = line.length;

  /** Consume `n` source characters into the command text. */
  const take = (n: number): void => {
    text += line.slice(i, i + n);
    i += n;
  };
  const push = (chars: string, interpreted: boolean): void => {
    value += chars;
    for (let k = 0; k < chars.length; k += 1) bare.push(interpreted);
    if (!interpreted) plain = false;
    open = true;
  };
  const resetWord = (): void => {
    value = '';
    bare = [];
    expansion = false;
    open = false;
    plain = true;
  };
  const endWord = (): void => {
    if (!open) return;
    const word: Word = { value, bare, expansion };
    if (pending !== null) {
      redirects.push({ kind: pending, target: word });
      pending = null;
    } else {
      words.push(word);
    }
    resetWord();
  };
  const endCommand = (): void => {
    endWord();
    if (pending !== null) {
      malformed = true;
      pending = null;
    }
    const trimmed = text.trim();
    if (trimmed.length > 0) commands.push({ text: trimmed, words, redirects });
    text = '';
    words = [];
    redirects = [];
  };
  const expect = (kind: Redirect['kind']): void => {
    if (pending !== null) malformed = true;
    pending = kind;
  };

  /** `$…` at position `i`, outside single quotes. */
  const dollar = (inDoubleQuotes: boolean): void => {
    const next = line[i + 1];
    if (next === '(' || next === '[') {
      substitution = true;
      expansion = true;
      push('$', false);
      take(1);
      return;
    }
    if (!inDoubleQuotes && (next === "'" || next === '"')) {
      opaque.add('ansi-c-quoting');
      push('$', false);
      take(1);
      return;
    }
    if (next === '{') {
      const close = line.indexOf('}', i + 2);
      if (close === -1) {
        malformed = true;
        push(line.slice(i), false);
        take(end - i);
        return;
      }
      if (!PLAIN_EXPANSION_BODY.test(line.slice(i + 2, close))) opaque.add('parameter-expansion');
      expansion = true;
      push(line.slice(i, close + 1), false);
      take(close + 1 - i);
      return;
    }
    SIMPLE_EXPANSION.lastIndex = i;
    const match = SIMPLE_EXPANSION.exec(line);
    if (match) {
      expansion = true;
      push(match[0], false);
      take(match[0].length);
      return;
    }
    push('$', false);
    take(1);
  };

  const doubleQuoted = (): void => {
    take(1);
    open = true;
    plain = false;
    while (i < end) {
      const ch = line[i]!;
      if (ch === '"') {
        take(1);
        return;
      }
      if (ch === '\\') {
        const next = line[i + 1];
        if (next === undefined) break;
        if (next === '\n') {
          // Deleted by the shell inside double quotes too : `"$\<newline>(id)"`.
          opaque.add('line-continuation');
          take(2);
        } else if (next === '$' || next === '`' || next === '"' || next === '\\') {
          push(next, false);
          take(2);
        } else {
          push(ch + next, false);
          take(2);
        }
        continue;
      }
      if (ch === '`') {
        substitution = true;
        push(ch, false);
        take(1);
        continue;
      }
      if (ch === '$') {
        dollar(true);
        continue;
      }
      push(ch, false);
      take(1);
    }
    malformed = true;
    take(end - i);
  };

  /** `<` or `>` at position `i`, outside quotes. */
  const redirectionOperator = (ch: '<' | '>'): void => {
    // Unquoted digits glued to the operator are the descriptor (`2>file`), not
    // an argument ; `''2>file` and `\2>file` run the command `2`.
    if (open && plain && /^\d+$/.test(value)) resetWord();
    else endWord();
    const next = line[i + 1];
    if (next === '&') {
      FD_DUPLICATION.lastIndex = i;
      const duplication = FD_DUPLICATION.exec(line);
      if (duplication) {
        take(duplication[0].length);
        return;
      }
      // Not a clean duplication. bash reads a `-` after `>&` / `<&` as a token
      // of its own, blanks allowed in between : `rm >&--rf x` runs `rm -rf x`.
      // The `-` is consumed alone, as bash does, and the line is opaque — as is
      // any descriptor followed by more text (`>&2file`, `>&2-`).
      let after = i + 2;
      while (line[after] === ' ' || line[after] === '\t') after += 1;
      const first = line[after];
      if (first === '-') {
        opaque.add('redirection');
        take(after + 1 - i);
        return;
      }
      if (ch === '<' || (first !== undefined && first >= '0' && first <= '9')) {
        opaque.add('redirection');
      }
      // `>&word` : stdout and stderr to the file `word`.
      if (ch === '>') redirection = true;
      take(2);
      expect(ch === '<' ? 'in' : 'out');
      return;
    }
    if (ch === '<') {
      if (next === '<') {
        opaque.add('here-document');
        take(line[i + 2] === '<' || line[i + 2] === '-' ? 3 : 2);
        expect('in');
        return;
      }
      if (next === '>') {
        redirection = true;
        take(2);
        expect('out');
        return;
      }
      take(1);
      expect('in');
      return;
    }
    redirection = true;
    take(next === '>' || next === '|' ? 2 : 1);
    expect('out');
  };

  while (i < end) {
    const ch = line[i]!;
    const next = line[i + 1];

    if (ch === '\\') {
      if (next === undefined) {
        malformed = true;
        take(1);
      } else if (next === '\n') {
        // The shell deletes a backslash-newline before it reads tokens, so one
        // glued to a token can build an operator this lexer never sees
        // (`$\<newline>'…'`, `<\<newline>(`). Only the continuation that follows a blank
        // is transparent.
        const previous = i === 0 ? ' ' : line[i - 1];
        if (open || !(previous === ' ' || previous === '\t' || previous === '\n')) {
          opaque.add('line-continuation');
        }
        take(2);
      } else {
        push(next, false);
        take(2);
      }
      continue;
    }
    if (ch === "'") {
      const close = line.indexOf("'", i + 1);
      if (close === -1) {
        malformed = true;
        push(line.slice(i + 1), false);
        take(end - i);
      } else {
        push(line.slice(i + 1, close), false);
        take(close + 1 - i);
      }
      continue;
    }
    if (ch === '"') {
      doubleQuoted();
      continue;
    }
    if (ch === '$') {
      dollar(false);
      continue;
    }
    if (ch === '`') {
      substitution = true;
      push(ch, false);
      take(1);
      continue;
    }
    if ((ch === '<' || ch === '>') && next === '(') {
      substitution = true;
      endWord();
      take(1);
      continue;
    }
    if (ch === '#' && !open) {
      // A comment runs to the end of the line ; the newline still ends the command.
      const newline = line.indexOf('\n', i);
      i = newline === -1 ? end : newline;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      endWord();
      take(1);
      continue;
    }
    if (ch === '\n' || ch === ';' || ch === '(' || ch === ')') {
      endCommand();
      i += 1;
      continue;
    }
    if (ch === '&') {
      if (next === '>') {
        endWord();
        redirection = true;
        take(line[i + 2] === '>' ? 3 : 2);
        expect('out');
        continue;
      }
      endCommand();
      i += next === '&' ? 2 : 1;
      continue;
    }
    if (ch === '|') {
      endCommand();
      i += next === '|' || next === '&' ? 2 : 1;
      continue;
    }
    if (ch === '<' || ch === '>') {
      redirectionOperator(ch);
      continue;
    }
    push(ch, true);
    take(1);
  }
  endCommand();

  if (hasControlCharacter(line)) opaque.add('control-character');
  if (substitution) opaque.add('substitution');
  if (malformed) opaque.add('malformed');

  return { commands, substitution, redirection, malformed, opaque: [...opaque] };
}

export interface SplitLine {
  /** Simple commands in order, trimmed, comments removed, empty ones dropped. */
  readonly commands: readonly string[];
  /** `$(`, backtick, `<(`, `>(` or `$[` seen outside single quotes. */
  readonly substitution: boolean;
  /** An output redirection (`>`, `>>`, `&>`, `>|`, `>&file`, `<>`) to a file seen outside quotes. */
  readonly redirection: boolean;
  /** A quote was left open, a backslash ends the line, or a redirection has no target. */
  readonly malformed: boolean;
  /** Why the line cannot be seen through ; empty when it can. */
  readonly opaque: readonly string[];
}

/**
 * Split a shell line into simple commands on `;`, `&&`, `||`, `|`, `&`,
 * newlines and the grouping parentheses, honouring quotes, backslash escapes
 * and comments. A view over `lexCommandLine` for callers that want text.
 */
export function splitCommandLine(line: string): SplitLine {
  const lexed = lexCommandLine(line);
  return {
    commands: lexed.commands.map((c) => c.text),
    substitution: lexed.substitution,
    redirection: lexed.redirection,
    malformed: lexed.malformed,
    opaque: lexed.opaque,
  };
}
