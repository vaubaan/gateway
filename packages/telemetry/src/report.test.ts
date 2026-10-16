import { describe, expect, it } from 'vitest';

import {
  createPluginReport,
  ERROR_CLASSES_BY_OUTCOME,
  httpErrorClass,
  isErrorClassOf,
  isPluginReport,
  PLUGIN_REPORT_KEYS,
  durationBucket,
  REPORT_OUTCOMES,
  type PluginReportInput,
} from './report.ts';

const VALID: PluginReportInput = {
  plugin: 'github',
  plugin_version: '1.2.3',
  gateway_version: '2.0.0-alpha.0',
  tool: 'github__get_file_contents',
  outcome: 'success',
  error_class: null,
  duration_bucket: 'lt_1s',
};

describe('PluginReport: the frozen shape', () => {
  it('has exactly the seven keys of spec §9, in a fixed order', () => {
    expect(PLUGIN_REPORT_KEYS).toEqual([
      'plugin',
      'plugin_version',
      'gateway_version',
      'tool',
      'outcome',
      'error_class',
      'duration_bucket',
    ]);
    expect(REPORT_OUTCOMES).toEqual([
      'success',
      'upstream-error',
      'classification-error',
      'execution-error',
    ]);
  });

  it('builds a frozen object with the seven keys and nothing the input smuggled in', () => {
    const smuggled = {
      ...VALID,
      arguments: { query: 'select 1' },
      arguments_hash: 'a'.repeat(64),
      mission_id: 'mis_1',
      instance_id: 'i-1',
      duration_ms: 812,
    };
    const report = createPluginReport(smuggled);
    expect(report).toEqual(VALID);
    expect(Object.keys(report ?? {})).toEqual([...PLUGIN_REPORT_KEYS]);
    expect(Object.isFrozen(report)).toBe(true);
  });

  it('accepts the unstamped gateway version of a development build', () => {
    expect(createPluginReport({ ...VALID, gateway_version: 'dev' })).not.toBeNull();
  });

  it.each([
    ['plugin with a space', { plugin: 'git hub' }],
    ['plugin in upper case', { plugin: 'GitHub' }],
    ['empty plugin', { plugin: '' }],
    ['plugin version that is not semver', { plugin_version: 'latest' }],
    ['plugin version carrying text', { plugin_version: '1.0.0 token=abc' }],
    ['gateway version that is free text', { gateway_version: 'host-42.internal' }],
    ['tool with a dash', { tool: 'github__get-file' }],
    ['tool carrying an argument', { tool: 'github__get_file?path=/etc/passwd' }],
    ['tool longer than the bound', { tool: `a${'b'.repeat(96)}` }],
    ['unknown outcome', { outcome: 'refused' }],
    ['error class on a success', { error_class: 'network' }],
    ['no error class on a failure', { outcome: 'upstream-error', error_class: null }],
    [
      'free-text error class',
      { outcome: 'upstream-error', error_class: 'relation "users" does not exist' },
    ],
    ['error class of another outcome', { outcome: 'execution-error', error_class: 'http_500' }],
    ['HTTP class out of range', { outcome: 'upstream-error', error_class: 'http_999' }],
    ['HTTP class with a suffix', { outcome: 'upstream-error', error_class: 'http_404_users' }],
    ['duration in milliseconds', { duration_bucket: '812' }],
    ['unknown duration bucket', { duration_bucket: 'lt_1min' }],
  ])('refuses a %s', (_name, override) => {
    expect(createPluginReport({ ...VALID, ...override } as PluginReportInput)).toBeNull();
  });

  it('refuses values that are not strings', () => {
    expect(createPluginReport({ ...VALID, plugin: 42 } as unknown as PluginReportInput)).toBeNull();
    expect(createPluginReport({ ...VALID, tool: null } as unknown as PluginReportInput)).toBeNull();
    expect(
      createPluginReport({ ...VALID, error_class: { $ne: null } } as unknown as PluginReportInput),
    ).toBeNull();
  });

  it('allows each named error class for its outcome only', () => {
    for (const [outcome, classes] of Object.entries(ERROR_CLASSES_BY_OUTCOME)) {
      for (const errorClass of classes) {
        for (const candidate of REPORT_OUTCOMES) {
          expect(isErrorClassOf(candidate, errorClass), `${candidate}/${errorClass}`).toBe(
            candidate === outcome,
          );
        }
      }
    }
    expect(isErrorClassOf('success', null)).toBe(true);
  });

  it('names an HTTP status as http_<status> and nothing else', () => {
    expect(httpErrorClass(404)).toBe('http_404');
    expect(httpErrorClass(599)).toBe('http_599');
    for (const bad of [0, 99, 600, 404.5, Number.NaN, -1]) expect(httpErrorClass(bad)).toBeNull();
    expect(isErrorClassOf('upstream-error', 'http_503')).toBe(true);
  });

  it('recognises a report by its exact keys', () => {
    expect(isPluginReport({ ...VALID })).toBe(true);
    expect(isPluginReport({ ...VALID, instance_id: 'i-1' })).toBe(false);
    const { tool: _tool, ...missing } = VALID;
    expect(isPluginReport(missing)).toBe(false);
    expect(isPluginReport([VALID])).toBe(false);
    expect(isPluginReport(null)).toBe(false);
  });

  it('puts a duration in one of four buckets and never travels the duration itself', () => {
    expect(durationBucket(0)).toBe('lt_100ms');
    expect(durationBucket(99.9)).toBe('lt_100ms');
    expect(durationBucket(100)).toBe('lt_1s');
    expect(durationBucket(999)).toBe('lt_1s');
    expect(durationBucket(1_000)).toBe('lt_10s');
    expect(durationBucket(10_000)).toBe('gte_10s');
    for (const odd of [-5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(['lt_100ms', 'gte_10s']).toContain(durationBucket(odd));
    }
  });
});
