/**
 * `/plugins/<id>`: the page of the service, the one `@vaubaan/plugin-page`
 * draws for the gateway's Reference too (website spec §2.3, sections 1–8),
 * with what is the site's alone: the crumbs, the gateways running the plugin
 * on the counts line, the health read from the collector (9), the links (10)
 * and the foot naming the Markdown twin, in the order `pluginPageMarkdown`
 * writes them. Paths of the page stay the site's own; the examples' source is
 * linked on GitHub.
 *
 * Imports are relative so the unit tests can render it.
 */
import { Inline, Mono, ServicePage } from '@vaubaan/plugin-page';

import { gatewaysSentence, healthFootnote, NOT_READ } from '../../content/health';
import {
  figureCells,
  pluginLinks,
  validatedSentence,
  type PluginWithHealth,
} from '../../content/plugin-pages';
import type { ValidationThresholds } from '../../content/thresholds';
import { githubBlob } from '../../site/constants';

function HealthBody({
  plugin,
  thresholds,
}: {
  plugin: PluginWithHealth;
  thresholds: ValidationThresholds;
}) {
  const health = plugin.health;
  return (
    <>
      <p className="pp-intro">{gatewaysSentence(health, thresholds.windowDays)}</p>
      {health.versions.length === 0 ? (
        <p>
          {health.minors[0]?.calls === NOT_READ && health.gateways === NOT_READ
            ? 'No figure: the collector did not answer when this page was rendered; the site tries again within the hour.'
            : 'No version of this plugin has reported a call or a gateway yet.'}
        </p>
      ) : (
        <div className="table-wrap">
          <table className="pp-tbl">
            <thead>
              <tr>
                {['Version', 'Gateways', 'Calls', 'Success', 'Validated'].map((h) => (
                  <th scope="col" key={h}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {health.versions.map((line) => (
                <tr key={line.label}>
                  <td>
                    <Mono>{line.label}</Mono>
                  </td>
                  {figureCells(line).map((cell, i) => (
                    <td key={i}>{cell}</td>
                  ))}
                  <td>{line.validated ? 'validated' : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p>
        <Inline text={validatedSentence(thresholds)} />
      </p>
      <p className="note">{healthFootnote(thresholds.windowDays)}</p>
    </>
  );
}

export function PluginPageView({
  plugin,
  thresholds,
  lastModified,
}: {
  plugin: PluginWithHealth;
  thresholds: ValidationThresholds;
  lastModified?: string | null;
}) {
  const links = pluginLinks(plugin);
  const twin = links[links.length - 1]!;

  return (
    <div className="mx-auto max-w-page px-4 pt-6 md:px-6 md:pt-10">
      <ServicePage
        plugin={plugin}
        sourceHref={githubBlob}
        crumbs={
          <>
            <a href="/plugins">Plugins</a> / {plugin.name}
          </>
        }
        meta={[gatewaysSentence(plugin.health, thresholds.windowDays)]}
        sections={[
          {
            id: 'health',
            kicker: 'Health',
            title: 'Health',
            body: <HealthBody plugin={plugin} thresholds={thresholds} />,
          },
          {
            id: 'links',
            kicker: 'Links',
            title: 'Links',
            body: (
              <ul className="links pp-plain">
                {links.map((l) => (
                  <li key={l.href}>
                    <a href={l.href}>{l.label}</a>
                  </li>
                ))}
              </ul>
            ),
          },
        ]}
        footer={
          <p className="mt-8 text-sm text-muted-foreground">
            {lastModified ? `Last changed ${lastModified}. ` : ''}
            This page as Markdown: <a href={twin.href}>{twin.href}</a>
          </p>
        }
      />
    </div>
  );
}
