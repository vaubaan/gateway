/**
 * `GET /healthz` — thin Next adapter over the host-agnostic handler.
 */
import { getRoot } from '@/server/compose';
import { healthHandler } from '@/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = healthHandler(() => getRoot());
