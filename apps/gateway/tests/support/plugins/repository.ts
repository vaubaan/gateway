/**
 * The plugins of this repository, for the tests, the demo and the e2e: every
 * `@vaubaan/plugin-<id>` package of the monorepo, in the order the image used to
 * bundle them. Production compiles only `vaubaan` and `ssh` (`SHIPPED_PLUGINS`)
 * and installs every other plugin from the catalog when first needed (ADR
 * plugins-installed-when-first-needed); a test that means "every plugin we
 * write" reads this list, never `SHIPPED_PLUGINS`.
 */
import asanaPlugin from '@vaubaan/plugin-asana';
import axonautPlugin from '@vaubaan/plugin-axonaut';
import caldavPlugin from '@vaubaan/plugin-caldav';
import cloudflareDnsPlugin from '@vaubaan/plugin-cloudflare-dns';
import context7Plugin from '@vaubaan/plugin-context7';
import flyPlugin from '@vaubaan/plugin-fly';
import githubPlugin from '@vaubaan/plugin-github';
import githubProjectsPlugin from '@vaubaan/plugin-github-projects';
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

export const REPOSITORY_PLUGINS: readonly ServicePlugin[] = [
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
  githubProjectsPlugin,
  vaubaanPlugin,
];

/** The registry of every plugin of this repository. */
export async function buildRepositoryRegistry(): Promise<PluginRegistry> {
  return createRegistry(REPOSITORY_PLUGINS);
}
