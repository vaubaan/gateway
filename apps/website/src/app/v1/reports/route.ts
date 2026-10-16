import { reportsRoute } from '@/collector/routes';

export const dynamic = 'force-dynamic';

export function POST(request: Request): Promise<Response> {
  return reportsRoute(request);
}
