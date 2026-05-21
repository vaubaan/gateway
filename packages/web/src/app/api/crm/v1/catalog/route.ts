/**
 * GET /api/crm/v1/catalog
 *
 * Returns the v1 catalogue of `ResourceKind`s — the static list known
 * to this build of @crm/catalog. Spec §6.1 (lecture seule, public-ish).
 *
 * The response is plain JSON: every field of `ResourceKind` that is
 * **serialisable** is emitted (id, provider, kindClass, displayName,
 * setupDocs, accessSchema, rotationMethod, egressHosts, plus
 * `manages` when the kind is `org-admin`). Function-shaped fields
 * (`healthTestCmd`, `mcpFragment`, `rotateSelf`, `listChildren`,
 * `createChild`, `destroyChild`, `rotateChildAccess`) are NOT
 * serialised — they are runtime-only and the wire format only carries
 * metadata.
 *
 * `egressHosts` is invoked with `{}` (an empty metadata bag): every
 * kind we ship today either ignores metadata or accepts the empty
 * shape with a defensive fallback. The wire format intentionally
 * returns a *static* allowlist — per-resource hosts (e.g.
 * `<projectRef>.supabase.co`) are computed at runtime by the Resource,
 * not the catalogue.
 *
 * No auth required: the catalogue is build-time metadata, the same
 * for every org. `Cache-Control: public, max-age=60` lets the CDN
 * and the browser cache it freely.
 */

import { NextResponse } from 'next/server';

import { CATALOG } from '@crm/catalog';

import { serializeKind, type SerializedKind } from '@/lib/catalog/serialize';

export const dynamic = 'force-static';

export interface CatalogListResponse {
  readonly kinds: readonly SerializedKind[];
}

export function GET(): NextResponse<CatalogListResponse> {
  const kinds = CATALOG.map(serializeKind);
  return NextResponse.json(
    { kinds },
    {
      status: 200,
      headers: {
        'Cache-Control': 'public, max-age=60, stale-while-revalidate=60',
      },
    },
  );
}
