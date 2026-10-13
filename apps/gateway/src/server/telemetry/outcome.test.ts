import { refuse, UpstreamFailureError, UpstreamRefusalError } from '@vaubaan/gateway-core';
import { UpstreamAuthError } from '@vaubaan/shared';
import { describe, expect, it } from 'vitest';

import type { PluginExecution, PluginOutcome } from '../execution/telemetry-sink';
import { classifyOutcome, reportOf } from './outcome';

const SECRET = 'sk-live-do-not-leak';

const thrown = (error: unknown): PluginOutcome => ({ ok: false, error });
const returned = (result: unknown): PluginOutcome => ({ ok: true, result });

function withProps<T extends Error>(error: T, props: Record<string, unknown>): T {
  return Object.assign(error, props);
}

describe('classifyOutcome', () => {
  it('a result that is not an error is a success', () => {
    expect(classifyOutcome(returned({ content: [{ type: 'text', text: SECRET }] }))).toEqual({
      outcome: 'success',
      error_class: null,
    });
    expect(classifyOutcome(returned({ content: [], isError: false }))).toEqual({
      outcome: 'success',
      error_class: null,
    });
    expect(classifyOutcome(returned(undefined)).outcome).toBe('success');
  });

  it('a result flagged isError is the executor refusing what its classifier let through', () => {
    expect(
      classifyOutcome(
        returned({ content: [{ type: 'text', text: `unknown tool ${SECRET}` }], isError: true }),
      ),
    ).toEqual({ outcome: 'classification-error', error_class: 'executor_refused' });
    // Only the boolean counts: a truthy string is not the flag.
    expect(classifyOutcome(returned({ isError: 'true' })).outcome).toBe('success');
  });

  it.each([
    ['UpstreamAuthError 401', new UpstreamAuthError(`bad token ${SECRET}`, 401), 'http_401'],
    ['UpstreamAuthError 403', new UpstreamAuthError('forbidden', 403), 'http_403'],
    ['an error with a numeric status', withProps(new Error(SECRET), { status: 422 }), 'http_422'],
    ['a rate limit', withProps(new Error('slow down'), { status: 429 }), 'http_429'],
    [
      'the host-built upstream failure',
      new UpstreamFailureError({ summary: 's', detail: SECRET, status: 502 }),
      'http_502',
    ],
    ['a plain Error', new Error(`relation "${SECRET}" does not exist`), 'unspecified'],
    ['fetch failed', new TypeError('fetch failed'), 'network'],
    [
      'fetch failed on a refused connection',
      new TypeError('fetch failed', { cause: withProps(new Error('x'), { code: 'ECONNREFUSED' }) }),
      'network',
    ],
    [
      'fetch failed on a connect timeout',
      new TypeError('fetch failed', {
        cause: withProps(new Error('x'), { code: 'UND_ERR_CONNECT_TIMEOUT' }),
      }),
      'timeout',
    ],
    ['a DNS failure', withProps(new Error('getaddrinfo'), { code: 'ENOTFOUND' }), 'network'],
    ['an aborted call', new DOMException('aborted', 'AbortError'), 'timeout'],
    ['a timed-out signal', new DOMException('timed out', 'TimeoutError'), 'timeout'],
    [
      'a credential refused for good',
      new UpstreamRefusalError(
        refuse.connectionUnavailable({
          connection: { id: 'con_1', name: SECRET },
          status: 'expired',
          owner: { kind: 'user', display: 'ada@example.com' },
        }),
      ),
      'credential_rejected',
    ],
  ])('%s is an upstream error', (_name, error, errorClass) => {
    expect(classifyOutcome(thrown(error))).toEqual({
      outcome: 'upstream-error',
      error_class: errorClass,
    });
  });

  it.each([
    [
      'a TypeError',
      new TypeError(`Cannot read properties of undefined (reading '${SECRET}')`),
      'type_error',
    ],
    ['a RangeError', new RangeError('Invalid array length'), 'range_error'],
    ['a ReferenceError', new ReferenceError(`${SECRET} is not defined`), 'reference_error'],
    ['a SyntaxError', new SyntaxError('Unexpected token < in JSON'), 'syntax_error'],
    ['a thrown string', SECRET, 'non_error_throw'],
    ['a thrown object', { message: SECRET, token: SECRET }, 'non_error_throw'],
    ['a thrown null', null, 'non_error_throw'],
    ['a thrown undefined', undefined, 'non_error_throw'],
  ])('%s is an execution error', (_name, error, errorClass) => {
    expect(classifyOutcome(thrown(error))).toEqual({
      outcome: 'execution-error',
      error_class: errorClass,
    });
  });

  it('never copies a name, a code, a message or an out-of-range status into the class', () => {
    const hostile = withProps(new Error(SECRET), {
      name: SECRET,
      code: SECRET,
      status: 99_999,
      statusText: SECRET,
    });
    expect(classifyOutcome(thrown(hostile))).toEqual({
      outcome: 'upstream-error',
      error_class: 'unspecified',
    });
    expect(classifyOutcome(thrown(withProps(new Error('x'), { status: SECRET })))).toEqual({
      outcome: 'upstream-error',
      error_class: 'unspecified',
    });
    expect(classifyOutcome(thrown(withProps(new Error('x'), { status: 404.5 }))).error_class).toBe(
      'unspecified',
    );
  });

  it('does not follow a cause chain forever', () => {
    const loop = new Error('a') as Error & { cause?: unknown };
    loop.cause = loop;
    expect(classifyOutcome(thrown(loop)).error_class).toBe('unspecified');
  });
});

describe('reportOf', () => {
  const plugin: PluginExecution['plugin'] = {
    id: 'depot',
    version: '1.4.0',
    tools: [
      { name: 'depot__read_item', description: 'Read.', inputSchema: { type: 'object' } },
      { name: 'depot__purge', description: 'Purge.', inputSchema: { type: 'object' } },
    ],
  };

  it('builds the six-key report from the plugin declaration and the outcome class', () => {
    expect(
      reportOf({ plugin, tool: 'depot__purge', outcome: thrown(new RangeError('x')) }, '2.1.0'),
    ).toEqual({
      plugin: 'depot',
      plugin_version: '1.4.0',
      gateway_version: '2.1.0',
      tool: 'depot__purge',
      outcome: 'execution-error',
      error_class: 'range_error',
    });
  });

  it('reports nothing for a tool the plugin does not declare', () => {
    expect(
      reportOf({ plugin, tool: `depot__${SECRET}`, outcome: returned({}) }, '2.1.0'),
    ).toBeNull();
    expect(
      reportOf({ plugin, tool: 'depot__write_item', outcome: returned({}) }, 'dev'),
    ).toBeNull();
  });

  it('reports nothing when a declared value does not fit the report', () => {
    expect(
      reportOf(
        {
          plugin: { ...plugin, version: 'nightly build' },
          tool: 'depot__purge',
          outcome: returned({}),
        },
        'dev',
      ),
    ).toBeNull();
    expect(
      reportOf({ plugin, tool: 'depot__purge', outcome: returned({}) }, 'gateway on host-7'),
    ).toBeNull();
  });
});
