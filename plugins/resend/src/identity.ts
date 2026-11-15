/**
 * Identity of the `resend` service — the one place its ids are written.
 *
 * Handbook : docs/handbook/services/resend.md.
 *
 * `SERVICE_ID` is also written as `service:` and as the prefix of every id
 * in `risk-catalog.yaml`, and in the package name. Everything else — the
 * plugin id, the data-model service, the tool names, the resources
 * discovery returns — is derived from this module.
 */

import { toolPrefixFor } from '@vaubaan/plugin-sdk';

/** The service id. */
export const SERVICE_ID = 'resend';

/** `resend__` : the prefix of every tool name. */
export const TOOL_PREFIX = toolPrefixFor(SERVICE_ID);

/** The MCP tool names, `resend__<verb>_<noun>`, in the order `tools/list` gives them. */
export const TOOL = {
  getEmail: `${TOOL_PREFIX}get_email`,
  listDomains: `${TOOL_PREFIX}list_domains`,
  getDomain: `${TOOL_PREFIX}get_domain`,
  listSegments: `${TOOL_PREFIX}list_segments`,
  getSegment: `${TOOL_PREFIX}get_segment`,
  listContacts: `${TOOL_PREFIX}list_contacts`,
  getContact: `${TOOL_PREFIX}get_contact`,
  listBroadcasts: `${TOOL_PREFIX}list_broadcasts`,
  getBroadcast: `${TOOL_PREFIX}get_broadcast`,
  describeZones: `${TOOL_PREFIX}describe_zones`,
  sendEmail: `${TOOL_PREFIX}send_email`,
  sendBatchEmails: `${TOOL_PREFIX}send_batch_emails`,
  createDomain: `${TOOL_PREFIX}create_domain`,
  updateDomain: `${TOOL_PREFIX}update_domain`,
  deleteDomain: `${TOOL_PREFIX}delete_domain`,
  verifyDomain: `${TOOL_PREFIX}verify_domain`,
  createSegment: `${TOOL_PREFIX}create_segment`,
  deleteSegment: `${TOOL_PREFIX}delete_segment`,
  createContact: `${TOOL_PREFIX}create_contact`,
  updateContact: `${TOOL_PREFIX}update_contact`,
  deleteContact: `${TOOL_PREFIX}delete_contact`,
  addContactToSegment: `${TOOL_PREFIX}add_contact_to_segment`,
  removeContactFromSegment: `${TOOL_PREFIX}remove_contact_from_segment`,
  createBroadcast: `${TOOL_PREFIX}create_broadcast`,
  updateBroadcast: `${TOOL_PREFIX}update_broadcast`,
  sendBroadcast: `${TOOL_PREFIX}send_broadcast`,
  deleteBroadcast: `${TOOL_PREFIX}delete_broadcast`,
} as const;
