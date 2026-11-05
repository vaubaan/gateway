/**
 * Classifier of the `outlook` provider: `(tool, args, resources) → slices`.
 *
 * Spec     : docs/spec/gateway-risk-model.md §3, §7 ; docs/spec/vaubaan-gateway.md
 *            §10 ("a classification error is a security hole").
 * Handbook : docs/handbook/providers/outlook.md.
 *
 * Pure. The call is read once by `readOutlookCall`; this file places what it
 * read on the data model. `m` is the mailbox ref (`[*]` when the slice
 * grammar cannot carry it), `c` the calendar (`default` or an id).
 *
 *   describe_zones        mailbox[m].R
 *   list_folders          mailbox[m].folder[*].R
 *   search_messages       mailbox[m].message[*].R + from-zone[z].R (+ bulk-marker.R) (+ draft[*].R in Drafts)
 *   get_message           mailbox[m].message[id].R + from-zone[unknown].R
 *   list_attachments      mailbox[m].message[id].attachment[*].R + from-zone[unknown].R
 *   get_attachment        mailbox[m].message[id].attachment[a].R + from-zone[unknown].R
 *   list_drafts           mailbox[m].draft[*].R
 *   create_draft,
 *   create_reply_draft    mailbox[m].draft.W + to-zone[z].W
 *   send_message,
 *   send_draft            mailbox[m].send-zone[z].W
 *   move_message,
 *   update_message        mailbox[m].message[id].W
 *   create_folder         mailbox[m].folder.W
 *   list_calendars        calendar[*].R
 *   list_events,
 *   search_events         calendar[c].event[*].R
 *   get_event             calendar[c].event[e].R
 *   suggest_time          free-busy.R
 *   create_event          calendar[c].event.W           (+ guests[z].W per zone invited)
 *   update_event          calendar[c].event[e].W        + event[e].notify.W (+ guests[z].W)
 *   delete_event          calendar[c].event[e].delete.W + event[e].notify.W
 *   respond_to_event      calendar[c].event[e].response.W
 *
 * `notify` is emitted on every update and deletion: Graph has no switch that
 * keeps Exchange from mailing the attendees, who are unknown before the call.
 */

import {
  ANY_IDENT,
  identSegment,
  type ClassifyOutcome,
  type Resource,
  type Slice,
  type SliceSegment,
} from '@vaubaan/plugin-sdk';

import { readOutlookCall, type OutlookCall } from './call.ts';
import { CALENDAR_TOOLS, PROVIDER_ID, TOOL } from './identity.ts';

const name = (value: string): SliceSegment => ({ kind: 'name', value });
const ident = (value: string | null): SliceSegment =>
  value === null ? ANY_IDENT : identSegment(value);

function slice(action: 'R' | 'W', path: readonly SliceSegment[]): Slice {
  return { provider: PROVIDER_ID, path, action };
}

function mailSlices(call: OutlookCall): Slice[] {
  const root = [name('mailbox'), ident(call.mailbox.ref)];
  const message = [...root, name('message'), ident(call.messageId)];
  const fromZones = call.fromZones.map((z) => slice('R', [...root, name('from-zone'), ident(z)]));
  switch (call.tool) {
    case TOOL.describeZones:
      return [slice('R', root)];
    case TOOL.listFolders:
      return [slice('R', [...root, name('folder'), ANY_IDENT])];
    case TOOL.searchMessages:
      return [
        slice('R', [...root, name('message'), ANY_IDENT]),
        ...fromZones,
        ...(call.bulk ? [slice('R', [...root, name('bulk-marker')])] : []),
        ...(call.readsDrafts ? [slice('R', [...root, name('draft'), ANY_IDENT])] : []),
      ];
    case TOOL.getMessage:
      return [slice('R', message), ...fromZones];
    case TOOL.listAttachments:
      return [slice('R', [...message, name('attachment'), ANY_IDENT]), ...fromZones];
    case TOOL.getAttachment:
      return [slice('R', [...message, name('attachment'), ident(call.attachmentId)]), ...fromZones];
    case TOOL.listDrafts:
      return [slice('R', [...root, name('draft'), ANY_IDENT])];
    case TOOL.createDraft:
    case TOOL.createReplyDraft:
      return [
        slice('W', [...root, name('draft')]),
        slice('W', [...root, name('to-zone'), ident(call.draftZone)]),
      ];
    case TOOL.sendMessage:
    case TOOL.sendDraft:
      return [slice('W', [...root, name('send-zone'), ident(call.sendZone)])];
    case TOOL.moveMessage:
    case TOOL.updateMessage:
      return [slice('W', message)];
    case TOOL.createFolder:
      return [slice('W', [...root, name('folder')])];
    default:
      throw new Error(`${PROVIDER_ID}: '${call.tool}' has no slice mapping`);
  }
}

function calendarSlices(call: OutlookCall): Slice[] {
  if (call.tool === TOOL.listCalendars) return [slice('R', [name('calendar'), ANY_IDENT])];
  if (call.tool === TOOL.suggestTime) return [slice('R', [name('free-busy')])];
  const root = [name('calendar'), ident(call.calendar)];
  const event = [...root, name('event'), ident(call.eventId)];
  const guests = call.guests.map((z) => slice('W', [...root, name('guests'), ident(z)]));
  const notify = slice('W', [...event, name('notify')]);
  switch (call.tool) {
    case TOOL.listEvents:
    case TOOL.searchEvents:
      return [slice('R', [...root, name('event'), ANY_IDENT])];
    case TOOL.getEvent:
      return [slice('R', event)];
    case TOOL.createEvent:
      return [slice('W', [...root, name('event')]), ...guests];
    case TOOL.updateEvent:
      return [slice('W', event), ...guests, notify];
    case TOOL.deleteEvent:
      return [slice('W', [...event, name('delete')]), notify];
    case TOOL.respondToEvent:
      return [slice('W', [...event, name('response')])];
    default:
      throw new Error(`${PROVIDER_ID}: '${call.tool}' has no slice mapping`);
  }
}

/** The slices of a call that `readOutlookCall` accepted. */
export function slicesOf(call: OutlookCall): Slice[] {
  return CALENDAR_TOOLS.has(call.tool) ? calendarSlices(call) : mailSlices(call);
}

export function classifyOutlook(
  tool: string,
  args: Readonly<Record<string, unknown>>,
  resources: readonly Resource[],
): ClassifyOutcome {
  const read = readOutlookCall(tool, args, resources);
  if ('denied' in read) return read;
  return { slices: slicesOf(read.call) };
}
