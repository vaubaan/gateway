/**
 * GET /api/crm/v1/catalog/:kindId
 *
 * Returns a single serialised `ResourceKind` by id. Spec §6.1.
 *
 * Same serialisation rules as the list endpoint (cf.
 * `../route.ts`): only data fields are emitted; runtime functions
 * (`healthTestCmd`, `mcpFragment`, provider operations) are excluded.
 *
 * Errors:
 *   - 404 `{ error: 'unknown_kind' }` when `:kindId` does not match
 *     any catalogue entry.
 *
 * No auth required (cf. list endpoint).
 */

import { NextResponse } from 'next/server';

import { findKind } from '@crm/catalog';

import { serializeKind, type SerializedKind } from '@/lib/catalog/serialize';

export const dynamic = 'force-static';

export interface CatalogKindResponse {
  readonly kind: SerializedKind;
}

export interface CatalogErrorResponse {
  readonly error: 'unknown_kind';
  readonly kindId: string;
}

interface RouteContext {
  readonly params: Promise<{ readonly kindId: string }>;
}

export async function GET(
  _req: Request,
  ctx: RouteContext,
): Promise<NextResponse<CatalogKindResponse | CatalogErrorResponse>> {
  const { kindId } = await ctx.params;
  const kind = findKind(kindId);
  if (kind === undefined) {
    return NextResponse.json({ error: 'unknown_kind' as const, kindId }, { status: 404 });
  }
  return NextResponse.json(
    { kind: serializeKind(kind) },
    {
      status: 200,
      headers: {
        'Cache-Control': 'public, max-age=60, stale-while-revalidate=60',
      },
    },
  );
}
