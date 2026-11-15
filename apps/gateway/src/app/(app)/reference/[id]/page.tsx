/**
 * `/reference/<id>` — the reference of one service (spec §4.2 "Reference"): the
 * plugin's own page, the very one the public site shows at `/plugins/<id>`
 * (`ServicePage` of `@vaubaan/plugin-page`, ADR service-page-is-one-shared-package),
 * drawn for the plugin version this instance runs — bundled or pinned, so a
 * pinned older plugin shows its own catalog. Above it, never inside it, a strip
 * says what only this instance knows: the version it runs and whether the
 * operator pinned it, the community validation of that version, and the
 * instance's git remote for the service.
 *
 * The page's links are paths of the documentation site, resolved under the
 * instance's `docs.url` (`docsSiteHref`); every permission and every
 * macro-action keeps its anchor (`#risk-<id>`, `#macro-<id>`), which the other
 * pages link to through `lib/providers/links.ts`.
 */
import { notFound } from 'next/navigation';

import { ServicePage } from '@vaubaan/plugin-page';
import '@vaubaan/plugin-page/plugin-page.css';

import { ValidationBadge } from '@/components/telemetry/ValidationBadge';
import { DocHint, Mono } from '@/components/ui';
import { requirePrincipal } from '@/lib/auth/session';
import { docsSiteHref } from '@/lib/docs-links';
import { providerCards } from '@/lib/providers/reference';
import { REFERENCE_WORDS, serviceDoc } from '@/lib/vocabulary';
import { gitRemoteBase } from '@/server/git/paths';
import { servicePageInfo } from '@/server/plugins/service-page';

import { pinnedPlugins, PinnedTag, ReferenceFrame } from '../frame';
import styles from '../reference.module.css';

export const dynamic = 'force-dynamic';

interface Props {
  params: Promise<{ id: string }>;
}

export default async function ServiceReferencePage({ params }: Props) {
  const { root } = await requirePrincipal();
  const { id } = await params;
  const registered = root.registry.get(id);
  if (!registered) notFound();
  const plugin = registered.plugin;
  const info = servicePageInfo(plugin);
  const validation = await root.telemetry.stats.statusFor(plugin.id);
  const pinned = pinnedPlugins(root.plugins).get(plugin.id);
  const docsRoot = root.config.docs.url.href;

  return (
    <ReferenceFrame cards={providerCards(root.registry)}>
      <div className={styles.strip} data-testid="instance-strip">
        <span className={styles.inline} data-testid="service-version">
          {REFERENCE_WORDS.runs} <Mono>{`plugin ${plugin.version}`}</Mono>
          <PinnedTag entry={pinned} withReplaced />
        </span>
        <ValidationBadge status={validation} />
        {plugin.gitRemote && (
          <span className={styles.wrapAnywhere} data-testid="instance-git-remote">
            {REFERENCE_WORDS.gitRemote}{' '}
            <Mono>{`${gitRemoteBase(root.config.publicUrl, plugin.id)}<owner>/<repo>.git`}</Mono>
          </span>
        )}
      </div>
      <div className={styles.servicePage}>
        <ServicePage
          plugin={info}
          titleLevel={2}
          href={(path) => docsSiteHref(docsRoot, path)}
          titleAside={
            <DocHint
              to={serviceDoc(plugin.id, info.name, 'page', plugin.description ?? null)}
              testId="page-doc-link"
            />
          }
        />
      </div>
    </ReferenceFrame>
  );
}
