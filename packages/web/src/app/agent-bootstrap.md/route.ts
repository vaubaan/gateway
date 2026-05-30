/**
 * GET /agent-bootstrap.md
 *
 * Serves the self-contained agent-bootstrap doc as raw markdown so that an LLM
 * (or any MCP client) can `curl` it and follow the instructions to use a
 * `vbn_live_*` access token. Content is in ./content.md ; this route just
 * reads it from disk with the right Content-Type.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const runtime = 'nodejs';
export const dynamic = 'force-static';

const here = path.dirname(fileURLToPath(import.meta.url));
const markdown = readFileSync(path.join(here, 'content.md'), 'utf-8');

export function GET(): Response {
  return new Response(markdown, {
    status: 200,
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Cache-Control': 'public, max-age=300, s-maxage=300',
    },
  });
}
