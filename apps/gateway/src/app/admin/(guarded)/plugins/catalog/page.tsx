/**
 * `/admin/plugins/catalog` — Administration › Plugins › Catalog (spec §4.2; intent "Browse
 * the catalog apart from what runs"): the catalog's plugins this instance does not run
 * (`pluginInstall.service.catalogOffer`, as the connect picker offers them), the archive
 * upload and the trusted signers. The view (`catalog-view.tsx`) decides nothing but how
 * to say it.
 */
import { requireOperator } from '@/lib/auth/session';

import { flashOf } from '../install-view';
import { CatalogPage } from './catalog-view';

export const dynamic = 'force-dynamic';

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function AdminPluginsCatalogPage({ searchParams }: Props) {
  const { root } = await requireOperator();
  const params = await searchParams;
  const service = root.pluginInstall.service;
  return (
    <CatalogPage
      view={{
        offer: service.catalogOffer(),
        install: {
          canInstall: root.pluginInstall.dir !== null,
          versions: [],
          activations: {},
          flash: flashOf(params),
          signers: (await service.listSigners()).map((signer) => ({
            keyId: signer.keyId,
            name: signer.name,
            addedAt: signer.addedAt,
            versions: signer.versions,
          })),
        },
      }}
    />
  );
}
