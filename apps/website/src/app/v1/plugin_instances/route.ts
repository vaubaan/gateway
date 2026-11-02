import { instancesRoute } from '@/collector/routes';

export const dynamic = 'force-dynamic';

export function GET(request: Request): Promise<Response> {
  return instancesRoute(request);
}
