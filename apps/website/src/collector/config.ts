/**
 * The collector's configuration, read from the environment of the Vercel
 * project (ADR telemetry-two-levels-behind-a-vercel-collector, D4). Nothing
 * has a default: a missing value is a deployment mistake, named in the error.
 *
 *   COLLECTOR_HOST                      the only host the collector answers on
 *                                       (`telemetry.vaubaan.com`)
 *   COLLECTOR_SUPABASE_URL              the dedicated project, `https://<ref>.supabase.co`
 *   COLLECTOR_SUPABASE_PUBLISHABLE_KEY  its publishable (anonymous) key; never the secret key
 */
export interface CollectorConfig {
  readonly host: string;
  readonly supabaseUrl: URL;
  readonly publishableKey: string;
}

export class CollectorConfigError extends Error {
  constructor(readonly variable: string) {
    super(`collector: ${variable} is not set`);
    this.name = 'CollectorConfigError';
  }
}

function required(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new CollectorConfigError(name);
  return value;
}

/** A secret key would give the function the rights RLS denies `anon`: refused. */
const SECRET_KEY_PREFIX = 'sb_secret_';

export function readCollectorConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): CollectorConfig {
  const host = required(env, 'COLLECTOR_HOST').toLowerCase();
  const supabaseUrl = new URL(required(env, 'COLLECTOR_SUPABASE_URL'));
  if (supabaseUrl.protocol !== 'https:') {
    throw new CollectorConfigError('COLLECTOR_SUPABASE_URL (https only)');
  }
  const publishableKey = required(env, 'COLLECTOR_SUPABASE_PUBLISHABLE_KEY');
  if (publishableKey.startsWith(SECRET_KEY_PREFIX)) {
    throw new CollectorConfigError('COLLECTOR_SUPABASE_PUBLISHABLE_KEY (a secret key was given)');
  }
  return { host, supabaseUrl, publishableKey };
}

/** True when the request was addressed to the collector's host; elsewhere its routes do not exist. */
export function isCollectorHost(request: Request, config: CollectorConfig): boolean {
  const host = request.headers.get('host')?.toLowerCase().replace(/:\d+$/, '');
  return host === config.host;
}
