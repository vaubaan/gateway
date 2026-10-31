/**
 * The command list of a push, read and judged before anything else (spec
 * §4.1 ter; ADR gateway-as-git-remote D4, D4 bis). Fail closed: what the
 * door does not implement is refused, never ignored. Which refs a mission may
 * push is the pipeline's question, for every command.
 */
import {
  GitProtocolError,
  OID_SHAPE,
  PktLineError,
  printableRef,
  readCommandList,
  type CommandList,
  type GitReviewedUpdate,
  type PktLineReader,
  type RefCommand,
} from '@vaubaan/plugin-sdk/git';

import { MAX_COMMAND_LIST_BYTES, MAX_PUSH_COMMANDS, MAX_REF_NAME_LENGTH } from './constants';

/**
 * The capabilities a client may ask for on a push: exactly what the door
 * advertises, plus `agent=` and `object-format=sha1`. `report-status` is
 * required: without it a client reads a refused push as a success.
 */
export const ACCEPTED_PUSH_CAPABILITIES = [
  'report-status',
  'side-band-64k',
  'quiet',
  'ofs-delta',
  'delete-refs',
] as const;
const REQUIRED_PUSH_CAPABILITY = 'report-status';
const AGENT_CAPABILITY = /^agent=[\x21-\x7e]{1,256}$/;

/** Read the command list off the request, bounded; the pack stays in the reader. */
export async function readPushCommands(
  reader: PktLineReader,
): Promise<{ readonly list: CommandList } | { readonly issue: string }> {
  let list: CommandList;
  try {
    list = await readCommandList(async () => {
      const pkt = await reader.read();
      if (reader.bytesRead > MAX_COMMAND_LIST_BYTES) {
        throw new GitProtocolError('the command list of this push is too long');
      }
      return pkt;
    });
  } catch (err) {
    if (err instanceof GitProtocolError || err instanceof PktLineError) {
      return { issue: `this push could not be read: ${err.message}` };
    }
    throw err;
  }
  if (list.pushCert) return { issue: 'signed pushes are not supported' };
  const issue = commandListIssue(list);
  return issue === null ? { list } : { issue };
}

/** A byte `git check-ref-format` never allows: control characters, space, `~^:?*[\`. */
function hasForbiddenRefByte(ref: string): boolean {
  for (const char of ref) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x20 || code === 0x7f || '~^:?*[\\'.includes(char)) return true;
  }
  return false;
}

/**
 * What the door refuses in a command list: a capability it did not
 * advertise (on any line), a missing `report-status`, too many commands, a
 * ref name too long or with a byte git never writes, the same ref twice, a
 * shallow line that is not an object id. `null` when the list is acceptable.
 */
export function commandListIssue(list: CommandList): string | null {
  for (const capability of list.capabilities) {
    const accepted =
      (ACCEPTED_PUSH_CAPABILITIES as readonly string[]).includes(capability) ||
      AGENT_CAPABILITY.test(capability) ||
      capability === 'object-format=sha1';
    if (!accepted) {
      return `the capability '${printableRef(capability)}' is not supported by this git remote (push without --atomic, --push-option or --signed)`;
    }
  }
  if (!list.capabilities.includes(REQUIRED_PUSH_CAPABILITY)) {
    return `this git remote requires the ${REQUIRED_PUSH_CAPABILITY} capability: without it a refused push would read as a success`;
  }
  if (list.commands.length > MAX_PUSH_COMMANDS) {
    return `a push may update at most ${MAX_PUSH_COMMANDS} refs at once; this one updates ${list.commands.length}`;
  }
  const seen = new Set<string>();
  for (const command of list.commands) {
    if (command.ref.length > MAX_REF_NAME_LENGTH || hasForbiddenRefByte(command.ref)) {
      return `'${printableRef(command.ref)}' is not a valid ref name`;
    }
    if (seen.has(command.ref)) return `'${printableRef(command.ref)}' is updated twice in one push`;
    seen.add(command.ref);
  }
  if (list.shallow.some((oid) => !OID_SHAPE.test(oid))) {
    return 'a shallow line of this push is not an object id';
  }
  return null;
}

/** What git sent, before any review: the precheck's arguments (fast-forward assumed, no files). */
export function provisional(c: RefCommand): GitReviewedUpdate {
  return {
    ref: c.ref,
    old: c.old,
    new: c.new,
    kind: c.old === null ? 'create' : c.new === null ? 'delete' : 'fast-forward',
    commits: 0,
    files: [],
    workflow_files: [],
  };
}
