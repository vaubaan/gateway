/**
 * Build the SSH command that executes one annotated bash tool function.
 *
 * Strategy : base64-encode the script + a trailing `<fn> "$@"` call, then on
 * the host decode it and pipe to `bash -s -- arg1 arg2 …`. This avoids all
 * quoting/heredoc-collision headaches : the script is opaque bytes until
 * `base64 -d` reconstructs it.
 *
 * The args are typed `string | integer` upstream ; we shell-escape them with
 * single quotes for the `bash -s --` boundary.
 */

export interface BuiltCommand {
  /** The full SSH command to send to the host. */
  cmd: string;
}

export function buildToolInvocation(
  bashContent: string,
  functionName: string,
  args: string[],
): BuiltCommand {
  // Script body + call to the function with `$@` so positional args from
  // `bash -s -- …` reach the function.
  const body = `${bashContent}\n${functionName} "$@"\n`;
  const b64 = Buffer.from(body, 'utf8').toString('base64');

  const quoted = args.map(shellQuote).join(' ');
  // `base64 -d` is GNU coreutils ; available on every Linux distro.
  const cmd = `echo ${shellQuote(b64)} | base64 -d | bash -s --${quoted ? ` ${quoted}` : ''}`;
  return { cmd };
}

function shellQuote(s: string): string {
  // POSIX-safe single-quoting : close quote, escape literal single quote,
  // reopen quote. Works regardless of the content.
  return `'${s.replace(/'/g, "'\\''")}'`;
}
