/**
 * The plugins this image ships — the default `RootDeps.buildRegistry`.
 *
 * This import list is where a provider enters the gateway: the registry built
 * from it is the single provider list (ADR plugin-contract-and-credential-spec
 * D6) and every other list — the connect picker, Admin → Provider apps, the
 * catalog index of the store, the tool list — derives from it. Adding a
 * provider is one import and one array entry here, plus the dependency in
 * `apps/gateway/package.json` (which is also what `next.config.ts` derives
 * `transpilePackages` from).
 *
 * `createRegistry` validates every plugin and rejects duplicate ids, so a
 * broken plugin fails the boot instead of the first call.
 */
import cloudflareDnsPlugin from '@vaubaan/plugin-cloudflare-dns';
import context7Plugin from '@vaubaan/plugin-context7';
import flyPlugin from '@vaubaan/plugin-fly';
import githubPlugin from '@vaubaan/plugin-github';
import gmailPlugin from '@vaubaan/plugin-gmail';
import miroPlugin from '@vaubaan/plugin-miro';
import notionPlugin from '@vaubaan/plugin-notion';
import railwayPlugin from '@vaubaan/plugin-railway';
import resendPlugin from '@vaubaan/plugin-resend';
import { createRegistry, type PluginRegistry, type ProviderPlugin } from '@vaubaan/plugin-sdk';
import sshPlugin from '@vaubaan/plugin-ssh';
import stripePlugin from '@vaubaan/plugin-stripe';
import supabasePlugin from '@vaubaan/plugin-supabase';
import upstashRedisPlugin from '@vaubaan/plugin-upstash-redis';
import vercelPlugin from '@vaubaan/plugin-vercel';

export const SHIPPED_PLUGINS: readonly ProviderPlugin[] = [
  githubPlugin,
  vercelPlugin,
  supabasePlugin,
  railwayPlugin,
  stripePlugin,
  cloudflareDnsPlugin,
  resendPlugin,
  upstashRedisPlugin,
  sshPlugin,
  gmailPlugin,
  flyPlugin,
  context7Plugin,
  miroPlugin,
  notionPlugin,
];

export async function buildShippedRegistry(): Promise<PluginRegistry> {
  return createRegistry(SHIPPED_PLUGINS);
}
