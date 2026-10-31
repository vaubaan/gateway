/**
 * Slices and catalog patterns walked on a data model : the template's shape
 * (a workspace, its widgets, a declared `delete` verb leaf) and the acme
 * fixture plugin.
 */
import { describe, expect, test } from 'vitest';

import { parseSlice } from '@vaubaan/policy-engine';
import type { DataModel } from '@vaubaan/shared';

import { catalogPathIssues, slicePathIssue } from '../../src/data-model-paths.ts';
import { assertSlicesOnDataModel, PluginAssertionError } from '../../src/testing/index.ts';
import { acmePlugin } from '../fixtures/acme/acme-plugin.ts';

const model: DataModel = {
  provider: 'acme',
  planes: [
    {
      slug: 'workspace',
      entities: [
        { name: 'account', parent: null, cardinalities: ['one'], description: 'a' },
        { name: 'workspace', parent: 'account', cardinalities: ['one'], description: 'w' },
        {
          name: 'widget',
          parent: 'workspace',
          cardinalities: ['one', 'unbounded'],
          description: 'x',
        },
        { name: 'delete', parent: 'widget', cardinalities: ['one'], description: 'd' },
        { name: 'tag', parent: 'widget', cardinalities: ['bounded'], description: 't' },
      ],
    },
  ],
};

const slice = (text: string) => slicePathIssue(model, parseSlice(text), 'slice');
const pattern = (text: string) => slicePathIssue(model, parseSlice(text), 'pattern');

describe('slicePathIssue — a classifier slice', () => {
  test('a path of the model, rooted at any declared entity', () => {
    expect(slice('acme.account[a].workspace[ws].widget[w].W')).toBeNull();
    expect(slice('acme.workspace[ws].widget[w].delete.W')).toBeNull();
    expect(slice('acme.workspace[ws].widget[*].R')).toBeNull();
    expect(slice('acme.workspace[ws].widget.W')).toBeNull();
  });

  test('a leaf one or two letters from an entity is a typo of it', () => {
    expect(slice('acme.workspace[ws].widgte[w].R')).toBe(
      "'widgte' is not below 'workspace' : did you mean 'widget' ?",
    );
  });

  test('a virtual leaf ends the path, with or without an identifier', () => {
    expect(slice('acme.workspace[ws].widget[w].publish.W')).toBeNull();
    expect(slice('acme.workspace[ws].widget[w].share[team].W')).toBeNull();
    expect(slice('acme.workspace[ws].widget[w].publish.tag[t].W')).toBe(
      "'publish' is not below 'widget' in the data model, and a virtual leaf ends the path",
    );
  });

  test('an undeclared root, an entity out of order, two identifiers, an identifier first', () => {
    expect(slice('acme.widgets[w].R')).toBe("'widgets' is not an entity of the data model");
    expect(slice('acme.workspace[ws].delete.tag[t].W')).toBe(
      "'delete' is not below 'workspace' in the data model, and a virtual leaf ends the path",
    );
    expect(slice('acme.workspace[ws][w].R')).toBe("two identifiers in a row after 'workspace'");
    expect(slice('acme.[ws].R')).toBe("identifier 'ws' before any entity");
  });

  test('each identifier in a cardinality the entity declares', () => {
    expect(slice('acme.workspace[*].R')).toBe("'workspace' is named by [*], but declares only one");
    expect(slice('acme.workspace[a,b].R')).toBe(
      "'workspace' is named by a list, but declares only one",
    );
    expect(slice('acme.workspace[ws].widget[w].tag.R')).toBe(
      "'tag' is named by one identifier, or none, but declares only bounded",
    );
    expect(
      slicePathIssue(model, parseSlice('acme.workspace[*].R'), 'slice', { cardinalities: false }),
    ).toBeNull();
  });

  test('no [**] in a slice : the classifier names what a call touches', () => {
    expect(slice('acme.workspace[ws].**.R')).toBe(
      "'[**]' in a slice : a classifier names what a call touches",
    );
  });
});

describe('slicePathIssue — a catalog pattern', () => {
  test('[**] and ** skip any number of segments ; cardinalities are not read', () => {
    expect(pattern('acme.**.W')).toBeNull();
    expect(pattern('acme.workspace[**].widget[**].W')).toBeNull();
    expect(pattern('acme.account.**.delete.W')).toBeNull();
    expect(pattern('acme.workspace[*].widget[a,b].R')).toBeNull();
  });

  test('a name after [**] must be below the entity before it', () => {
    expect(pattern('acme.widget[**].workspace.tag.R')).toBe(
      "'workspace' is not below 'widget' in the data model, and a virtual leaf ends the path",
    );
  });
});

describe('catalogPathIssues', () => {
  test('the acme fixture names only entities of its model', () => {
    expect(catalogPathIssues(acmePlugin)).toEqual([]);
  });

  test('a typo in a pattern is reported with its risk ; a deprecated entry is not read', () => {
    const risks = acmePlugin.catalog.risks;
    const typo = { ...risks[0]!, matches: 'acme.space[**].thnig[**].R' };
    const old = { ...risks[1]!, deprecated: true, matches: 'acme.gone[**].W' };
    expect(
      catalogPathIssues({ ...acmePlugin, catalog: { ...acmePlugin.catalog, risks: [typo, old] } }),
    ).toEqual([
      `risks[0] '${typo.id}' matches 'acme.space[**].thnig[**].R': 'thnig' is not below 'space' : did you mean 'thing' ?`,
    ]);
  });
});

describe('assertSlicesOnDataModel', () => {
  test('passes when every sample slice is a path of the model', () => {
    expect(() =>
      assertSlicesOnDataModel(acmePlugin, {
        acme__list_things: [{ args: { space: 'sp-1' } }],
        acme__update_thing: [{ args: { space: 'sp-1', thing_id: 't-1', name: 'n' } }],
      }),
    ).not.toThrow();
  });

  test('lists every slice off the model, naming the sample', () => {
    const offModel = {
      ...acmePlugin,
      dataModel: { ...acmePlugin.dataModel, planes: [] },
    };
    expect(() =>
      assertSlicesOnDataModel(offModel, { acme__list_things: [{ args: { space: 'sp-1' } }] }),
    ).toThrow(PluginAssertionError);
    expect(() =>
      assertSlicesOnDataModel(offModel, { acme__list_things: [{ args: { space: 'sp-1' } }] }),
    ).toThrow(
      "'acme__list_things' sample #1: 'acme.space[sp-1].thing[*].R': 'space' is not an entity",
    );
  });
});
