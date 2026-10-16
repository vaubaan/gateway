/**
 * What each tool of the `resend` provider does, in a few words a person reads at
 * a glance (`ProviderPlugin.toolTitles`) : the head of an approval request in
 * the web interface, before the resource the call resolves to. A verb and its
 * object, sentence case, no final period. For people only : never part of
 * `tools/list`, and the host decides nothing from it.
 *
 * A structural test of the gateway checks that every tool of a shipped plugin
 * has its title : a new tool is added here with its declaration.
 */

export const resendToolTitles: Readonly<Record<string, string>> = {
  resend__get_email: 'Read the status of a sent email',
  resend__list_domains: 'List sending domains',
  resend__get_domain: 'Read a sending domain',
  resend__list_segments: 'List segments',
  resend__get_segment: 'Read a segment',
  resend__list_contacts: 'List contacts',
  resend__get_contact: 'Read a contact',
  resend__list_broadcasts: 'List broadcasts',
  resend__get_broadcast: 'Read a broadcast',
  resend__describe_zones: 'Read the recipient zones',
  resend__send_email: 'Send an email',
  resend__send_batch_emails: 'Send a batch of emails',
  resend__create_domain: 'Add a sending domain',
  resend__update_domain: 'Change a sending domain',
  resend__delete_domain: 'Remove a sending domain',
  resend__verify_domain: 'Re-check a sending domain',
  resend__create_segment: 'Create a segment',
  resend__delete_segment: 'Delete a segment',
  resend__create_contact: 'Create a contact',
  resend__update_contact: 'Change a contact',
  resend__delete_contact: 'Delete a contact',
  resend__add_contact_to_segment: 'Add a contact to a segment',
  resend__remove_contact_from_segment: 'Remove a contact from a segment',
  resend__create_broadcast: 'Create a draft broadcast',
  resend__update_broadcast: 'Change a draft broadcast',
  resend__send_broadcast: 'Send a broadcast to its segment',
  resend__delete_broadcast: 'Delete a broadcast',
};
