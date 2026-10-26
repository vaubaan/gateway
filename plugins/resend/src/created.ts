/**
 * The domain or the segment a successful `resend__create_domain` /
 * `resend__create_segment` created, read from Resend's answer (ADR
 * created-resources-join-the-mission). Handbook : docs/handbook/providers/resend.md.
 *
 * The plugin builds the answer itself : the JSON of Resend's `POST /domains`
 * (`{ id, name, status, region, records, … }`) or `POST /segments`
 * (`{ object: 'segment', id, name }`). The answer is untrusted : the id must
 * be a path identifier and the domain name a domain name, the grammars
 * discovery's refs and the request paths use. The resource is described as
 * discovery describes it : a domain with its `domain_id`, status, region and
 * empty recipient zones ; a segment with its `segment_id`.
 */

import { jsonObjectsOf, type McpToolResult, type Resource } from '@vaubaan/plugin-sdk';

import { RESEND_PROVIDER, domainName, pathIdent } from './resources.ts';

const CREATE_DOMAIN = 'resend__create_domain';
const CREATE_SEGMENT = 'resend__create_segment';

/** `ProviderPlugin.createdResources` : the domain or segment the call made, or `[]`. */
export function createdResendResources(
  tool: string,
  _args: Readonly<Record<string, unknown>>,
  result: McpToolResult,
): readonly Resource[] {
  const [answer] = jsonObjectsOf(result);
  if (!answer) return [];
  const id = pathIdent(answer.id);
  if (id === null) return [];
  if (tool === CREATE_DOMAIN) {
    const name = typeof answer.name === 'string' ? answer.name : null;
    const ref = domainName(name);
    if (ref === null || name === null) return [];
    const status = typeof answer.status === 'string' && answer.status ? answer.status : null;
    const region = typeof answer.region === 'string' && answer.region ? answer.region : null;
    return [
      {
        provider: RESEND_PROVIDER,
        ref,
        displayName: status === 'verified' || status === null ? name : `${name} (${status})`,
        metadata: {
          kind: 'domain',
          domain_id: id,
          ...(status ? { status } : {}),
          ...(region ? { region } : {}),
          internal_domains: [],
          allowlist_domains: [],
          allowlist_addresses: [],
        },
      },
    ];
  }
  if (tool === CREATE_SEGMENT) {
    const name = typeof answer.name === 'string' && answer.name.trim() ? answer.name : id;
    return [
      {
        provider: RESEND_PROVIDER,
        ref: id,
        displayName: name,
        metadata: { kind: 'segment', segment_id: id },
      },
    ];
  }
  return [];
}
