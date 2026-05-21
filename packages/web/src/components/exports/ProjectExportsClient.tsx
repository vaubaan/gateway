'use client';

/**
 * `<ProjectExportsClient>` — client wrapper for the project-scoped
 * exports page. Owns the variant state.
 *
 * No cloud-resource-map button at the project level — that export is
 * always whole-org per spec §6.7.1.
 */

import { useState } from 'react';
import type { ReactElement } from 'react';

import { DotenvExportButton } from './DotenvExportButton';
import { McpExportButton } from './McpExportButton';
import { RegenerateMcpButton } from './RegenerateMcpButton';
import { VariantSelector } from './VariantSelector';

export interface ProjectExportsClientProps {
  readonly orgSlug: string;
  readonly projectId: string;
  readonly projectSlug: string;
  readonly variants: ReadonlyArray<string>;
}

export function ProjectExportsClient(props: ProjectExportsClientProps): ReactElement {
  const { orgSlug, projectId, projectSlug, variants } = props;
  const [variant, setVariant] = useState<string>('');
  const v = variant === '' ? null : variant;
  const scope = { kind: 'project' as const, scopeId: projectId };
  const stem = `${orgSlug}-${projectSlug}${variant ? `-${variant}` : ''}`;

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium text-neutral-700">Scope</h2>
        <VariantSelector variants={variants} value={variant} onChange={setVariant} />
        <p className="text-xs text-neutral-500">
          Without a variant, the bundle includes every Resource attached to this project (variant IS
          NULL or any variant), plus the org-scoped Resources.
        </p>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium text-neutral-700">.env bundle</h2>
        <div className="flex gap-2">
          <DotenvExportButton
            orgSlug={orgSlug}
            scope={scope}
            variant={v}
            format="dotenv"
            filenameStem={stem}
          />
          <DotenvExportButton
            orgSlug={orgSlug}
            scope={scope}
            variant={v}
            format="json"
            filenameStem={stem}
          />
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium text-neutral-700">mcp.json + .env companion</h2>
        <div className="flex flex-col gap-2">
          <McpExportButton orgSlug={orgSlug} scope={scope} variant={v} filenameStem={stem} />
          <RegenerateMcpButton orgSlug={orgSlug} scope={scope} variant={v} />
        </div>
      </section>
    </div>
  );
}
