/**
 * The plugins this image bundles. The root composes them with the plugins the
 * operator pins in `plugins.dir` and filters them by `plugins.enabled`
 * (`server/plugins`, ADR plugins-bundled-or-pinned-by-the-operator); a pin of
 * the same id replaces the bundled plugin.
 *
 * This import list is where a service enters the gateway: the registry built
 * from it is the single service list (ADR plugin-contract-and-credential-spec
 * D6) and every other list — the connect picker, Admin → Service apps, the
 * catalog index of the store, the tool list — derives from it. Adding a
 * service is one import and one array entry here, plus the dependency in
 * `apps/gateway/package.json` (which is also what `next.config.ts` derives
 * `transpilePackages` from).
 *
 * `createRegistry` validates every plugin and rejects duplicate ids, so a
 * broken plugin fails the boot instead of the first call. `buildShippedRegistry`
 * is the bundled set alone, for the tests that read no pin; `reseal` composes its
 * registry with `loadPlugins`, as the root does.
 */
import asanaPlugin from '@vaubaan/plugin-asana';
import axonautPlugin from '@vaubaan/plugin-axonaut';
import caldavPlugin from '@vaubaan/plugin-caldav';
import cloudflareDnsPlugin from '@vaubaan/plugin-cloudflare-dns';
import context7Plugin from '@vaubaan/plugin-context7';
import flyPlugin from '@vaubaan/plugin-fly';
import githubPlugin from '@vaubaan/plugin-github';
import gmailPlugin from '@vaubaan/plugin-gmail';
import googleCalendarPlugin from '@vaubaan/plugin-google-calendar';
import miroPlugin from '@vaubaan/plugin-miro';
import notionPlugin from '@vaubaan/plugin-notion';
import outlookPlugin from '@vaubaan/plugin-outlook';
import railwayPlugin from '@vaubaan/plugin-railway';
import resendPlugin from '@vaubaan/plugin-resend';
import { createRegistry, type PluginRegistry, type ServicePlugin } from '@vaubaan/plugin-sdk';
import sshPlugin from '@vaubaan/plugin-ssh';
import stripePlugin from '@vaubaan/plugin-stripe';
import supabasePlugin from '@vaubaan/plugin-supabase';
import upstashRedisPlugin from '@vaubaan/plugin-upstash-redis';
import vaubaanPlugin from '@vaubaan/plugin-vaubaan';
import vercelPlugin from '@vaubaan/plugin-vercel';

export const SHIPPED_PLUGINS: readonly ServicePlugin[] = [
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
  caldavPlugin,
  googleCalendarPlugin,
  asanaPlugin,
  axonautPlugin,
  outlookPlugin,
  // The gateway's own management tools: a host account, bound by the root to the
  // mission service (`compose/vaubaan.ts`; ADR platform-management-is-a-plugin-on-the-execution-door).
  vaubaanPlugin,
];

export async function buildShippedRegistry(): Promise<PluginRegistry> {
  return createRegistry(SHIPPED_PLUGINS);
}
