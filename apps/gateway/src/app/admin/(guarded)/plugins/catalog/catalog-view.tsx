/**
 * Administration › Plugins › Catalog, from a view the page assembles (`page.tsx`): the
 * catalog's plugins this gateway does not run, each installed in one click (downloaded,
 * verified, run on trial), then what an administrator brings of their own — an archive to
 * upload, the signers of their private plugins (intent "Browse the catalog apart from what
 * runs"). Pure: a unit test renders it over invented views.
 */
import styles from '@/components/settings/settings.styles';
import { Button, Hint, Mono, PageHeader, Row, Rows, Section, ServiceMark } from '@/components/ui';
import { PIN_A_PLUGIN_DOC } from '@/lib/project-docs';
import { DOC_PAGES, PLUGIN_WORDS, SETTINGS_PAGES } from '@/lib/vocabulary';
import { PLUGIN_ACTIONS, PLUGINS_PAGE, UPDATE_FIELD } from '@/server/plugins/handlers';

import { Flash, Signers, UploadSection, type InstallView } from '../install-view';

export interface CatalogView {
  /** The catalog's plugins this gateway does not run, by name. */
  readonly offer: readonly {
    readonly id: string;
    readonly released: string;
    readonly name?: string;
  }[];
  readonly install: InstallView;
}

export function CatalogPage({ view }: { view: CatalogView }) {
  const { offer, install } = view;
  const offered = [...offer].sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id));
  return (
    <>
      <PageHeader
        doc={DOC_PAGES.plugins}
        crumbs={[{ label: SETTINGS_PAGES.plugins.title, href: PLUGINS_PAGE }]}
        title={SETTINGS_PAGES.pluginsCatalog.title}
        lede={SETTINGS_PAGES.pluginsCatalog.lede}
      />
      <Flash flash={install.flash} />
      <Section
        title={PLUGIN_WORDS.catalogTitle}
        count={offered.length}
        first
        testId="catalog-plugins"
      >
        {offered.length > 0 ? (
          <Rows>
            {offered.map((plugin) => (
              <Row
                key={plugin.id}
                testId={`available-plugin-${plugin.id}`}
                lead={<ServiceMark name={plugin.name ?? plugin.id} icon={null} />}
                title={plugin.name ?? plugin.id}
                description={
                  <>
                    <Mono>{plugin.id}</Mono> · <Mono>{plugin.released}</Mono>
                  </>
                }
                {...(install.canInstall
                  ? {
                      end: (
                        <form
                          method="post"
                          action={PLUGIN_ACTIONS.update}
                          className={styles.inlineForm}
                        >
                          <input
                            type="hidden"
                            name={UPDATE_FIELD}
                            value={`${plugin.id}@${plugin.released}`}
                          />
                          <Button
                            type="submit"
                            size="sm"
                            data-testid={`install-catalog-${plugin.id}`}
                          >
                            {PLUGIN_WORDS.install}
                          </Button>
                        </form>
                      ),
                    }
                  : {})}
              />
            ))}
          </Rows>
        ) : (
          <Hint>{PLUGIN_WORDS.catalogEmpty}</Hint>
        )}
      </Section>
      <UploadSection canInstall={install.canInstall} />
      {install.signers && <Signers signers={install.signers} />}
      <Hint>
        {PLUGIN_WORDS.changes}{' '}
        <a href={PIN_A_PLUGIN_DOC} rel="noreferrer noopener" target="_blank">
          {PLUGIN_WORDS.howToPin}
        </a>
        .
      </Hint>
    </>
  );
}
