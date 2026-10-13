/**
 * @deprecated legacy v4, deleted in P1.6 — the module moved to
 * `plugins/ssh/src/bash/parse.ts` (P1.2i). Thin re-export kept for the v4
 * bash-bindings routes and pages ; nothing new may import this path.
 */
export {
  parseAnnotatedBash,
  summarize,
  ParseError,
  type ParsedArg,
  type ParsedScript,
  type ParsedTool,
} from '@vaubaan/plugin-ssh';
