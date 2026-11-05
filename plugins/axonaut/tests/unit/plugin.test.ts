/**
 * Mandatory suite of the `axonaut` plugin : the SDK kit (well-formed, no
 * wildcard, catalog coverage, data model, the identifier proof), the
 * macro-actions at their trust levels, the identity and the version.
 * No network : `execute` runs against `mockFetch`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import { catalogPathIssues, catalogPathNextTo, toolPrefixFor } from '@vaubaan/plugin-sdk';
import {
  assertCatalogCoverage,
  assertIdentifiersRefused,
  assertNoWildcard,
  assertPluginWellFormed,
  assertSlicesOnDataModel,
  policyFromMacroActions,
} from '@vaubaan/plugin-sdk/testing';

import { API_KEY_FIELD, PROVIDER_ID, TOOL } from '../../src/identity.ts';
import defaultExport, { axonautCatalog, axonautPlugin } from '../../src/index.ts';
import { KEY, SAMPLES, account } from './fixtures.ts';

describe('axonaut plugin — structural kit', () => {
  test('well-formed, no wildcard', () => {
    assertPluginWellFormed(axonautPlugin);
    assertNoWildcard(axonautPlugin);
  });

  test('every tool classifies to slices the catalog covers, none by the fallback', () => {
    const report = assertCatalogCoverage(axonautPlugin, SAMPLES, { resources: [account] });
    assertSlicesOnDataModel(axonautPlugin, SAMPLES, { resources: [account] });
    expect(catalogPathIssues(axonautPlugin)).toEqual([]);
    const named = axonautCatalog.catalog.risks.filter((r) => !r.fallback).map((r) => r.id);
    expect([...report.risksTouched].sort()).toEqual([...named].sort());
    expect(report.risksTouched).toHaveLength(13);
    expect(report.risksUntouched).toEqual([]);
    expect(report.fallbackHits).toEqual([]);
  });

  test('hostile identifiers are refused by classify and by execute, or named exactly', async () => {
    const report = await assertIdentifiersRefused(axonautPlugin, SAMPLES, {
      resources: [account],
      context: (fetch, resources) => ({
        credential: { kind: 'api-key', fields: { [API_KEY_FIELD]: KEY }, metadata: {} },
        fetch,
        resources,
      }),
    });
    expect(report.toolsChecked).toBe(axonautPlugin.tools.length);
    expect(report.pathIdentifiers).toContainEqual({
      tool: TOOL.getCompany,
      argument: 'company_id',
    });
    expect(report.pathIdentifiers).toContainEqual({ tool: TOOL.deleteTask, argument: 'task_id' });
    expect(report.pathIdentifiers).toContainEqual({
      tool: TOOL.setQuotationOutcome,
      argument: 'quotation_id',
    });
  });

  test('the catalog is read from a filesystem path next to the plugin module', () => {
    const path = catalogPathNextTo(new URL('../../src/index.ts', import.meta.url));
    expect(path).toBe(fileURLToPath(new URL('../../src/risk-catalog.yaml', import.meta.url)));
    expect(existsSync(path)).toBe(true);
    expect(axonautCatalog.catalog.provider).toBe(PROVIDER_ID);
    expect(axonautCatalog.catalog.risks.find((r) => r.fallback)?.id).toBe(
      `${PROVIDER_ID}.uncategorized-write`,
    );
  });

  test('tool names are derived from the provider id, once, and each has a title', () => {
    const prefix = toolPrefixFor(PROVIDER_ID);
    expect(axonautPlugin.tools.map((t) => t.name)).toEqual(Object.values(TOOL));
    expect(Object.values(TOOL).every((name) => name.startsWith(prefix))).toBe(true);
    expect(Object.keys(axonautPlugin.toolTitles ?? {}).sort()).toEqual(Object.values(TOOL).sort());
    // Every tool takes the account, and declares no bank or mandate field.
    for (const tool of axonautPlugin.tools) {
      const properties = Object.keys(tool.inputSchema.properties ?? {});
      expect(properties, tool.name).toContain('account');
      expect(properties.filter((p) => /iban|bic|mandate|sepa|custom_fields/i.test(p))).toEqual([]);
    }
    expect(axonautPlugin.credential).toMatchObject({
      kind: 'api-key',
      fields: [{ name: API_KEY_FIELD, secret: true }],
    });
  });

  test('the plugin is the default export, and its version is the package version', () => {
    expect(defaultExport).toBe(axonautPlugin);
    const manifest: unknown = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    );
    expect(manifest).toMatchObject({ version: axonautPlugin.version });
  });
});

describe('axonaut macro-actions', () => {
  test('four macro-actions, explicit risks, the fallback in none', () => {
    const { risks, macro_actions: actions } = axonautCatalog.catalog;
    expect(actions.map((a) => a.id)).toEqual(['read', 'crm', 'sell', 'clean-up']);
    const fallback = risks.find((r) => r.fallback)?.id;
    for (const entry of actions.flatMap((a) => a.entries)) {
      expect(entry.risk_id).not.toMatch(/[*?[\]]/);
      expect(entry.risk_id).not.toBe(fallback);
    }
  });

  test('at Careful : catalog reads run freely, personal data and costly acts ask, invoices and deletions stay out', () => {
    const policy = policyFromMacroActions(axonautPlugin, {
      read: 'careful',
      crm: 'careful',
      sell: 'careful',
      'clean-up': 'careful',
    });
    const gates = Object.fromEntries(policy.map((line) => [line.risk_id, line.gate]));
    expect(gates).toMatchObject({
      'axonaut.read-sales': 'auto',
      'axonaut.read-work': 'auto',
      'axonaut.read-catalog': 'auto',
      'axonaut.read-crm': 'approval',
      'axonaut.opportunity-write': 'auto',
      'axonaut.work-write': 'auto',
      'axonaut.quotation-create': 'auto',
      'axonaut.crm-write': 'approval',
      'axonaut.opportunity-outcome': 'approval',
      'axonaut.quotation-outcome': 'approval',
      'axonaut.payment-record': 'approval',
    });
    expect(Object.keys(gates)).not.toContain('axonaut.invoice-create');
    expect(Object.keys(gates)).not.toContain('axonaut.delete-record');
    expect(Object.keys(gates)).not.toContain(`${PROVIDER_ID}.uncategorized-write`);
  });

  test('at Autonomous only the irreversible asks first : invoices and deletions', () => {
    const policy = policyFromMacroActions(axonautPlugin, {
      read: 'autonomous',
      crm: 'autonomous',
      sell: 'autonomous',
      'clean-up': 'autonomous',
    });
    const gated = policy.filter((l) => l.gate === 'approval').map((l) => l.risk_id);
    expect(gated.sort()).toEqual(['axonaut.delete-record', 'axonaut.invoice-create']);
  });
});
