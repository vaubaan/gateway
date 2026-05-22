'use client';

/**
 * `<OrgExportsClient>` — client wrapper for the org-scoped exports
 * page. Owns the variant state and wires the 4 buttons.
 *
 * Spec §11.1.
 */

import { useState } from 'react';
import type { ReactElement } from 'react';

import { CloudResourceMapButton } from './CloudResourceMapButton';
import { DotenvExportButton } from './DotenvExportButton';
import { McpExportButton } from './McpExportButton';
import { RegenerateMcpButton } from './RegenerateMcpButton';
import { VariantSelector } from './VariantSelector';

export interface OrgExportsClientProps {
  readonly orgSlug: string;
  readonly variants: ReadonlyArray<string>;
}

export function OrgExportsClient(props: OrgExportsClientProps): ReactElement {
  const { orgSlug, variants } = props;
  const [variant, setVariant] = useState<string>('');
  const v = variant === '' ? null : variant;
  const scope = { kind: 'org' as const };

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium text-foreground">Scope</h2>
        <VariantSelector variants={variants} value={variant} onChange={setVariant} />
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium text-foreground">.env bundle</h2>
        <p className="text-xs text-muted">
          Sealed blobs for every Access visible at scope. Browser unseals and assembles the file.
        </p>
        <div className="flex gap-2">
          <DotenvExportButton orgSlug={orgSlug} scope={scope} variant={v} format="dotenv" />
          <DotenvExportButton orgSlug={orgSlug} scope={scope} variant={v} format="json" />
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium text-foreground">mcp.json + .env companion</h2>
        <p className="text-xs text-muted">
          Downloads the composed <code>mcp.json</code> snapshot followed by its{' '}
          <code>.env-mcp</code> companion (placeholders resolved via unseal where possible).
        </p>
        <div className="flex flex-col gap-2">
          <McpExportButton orgSlug={orgSlug} scope={scope} variant={v} />
          <RegenerateMcpButton orgSlug={orgSlug} scope={scope} variant={v} />
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium text-foreground">cloud-resource-map.json</h2>
        <p className="text-xs text-muted">
          JSON metadata map consumed by the Coding Agent Runner — zero secrets, just metadata +
          references to <code>(secret_manager.kind, .name)</code> per Access.
        </p>
        <CloudResourceMapButton orgSlug={orgSlug} />
      </section>
    </div>
  );
}
