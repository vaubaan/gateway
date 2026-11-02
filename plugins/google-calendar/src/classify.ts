/**
 * Classifier of the `google-calendar` provider: `(tool, args, resources) → slices`.
 *
 * Spec     : docs/spec/gateway-risk-model.md §3, §7 ; docs/spec/vaubaan-gateway.md
 *            §10 ("a classification error is a security hole").
 * Handbook : docs/handbook/providers/google-calendar.md.
 *
 * Pure. The call is read once by `readCalendarCall`; this file places what
 * it read on the data model. Every slice of a call that names a calendar is
 * rooted at `google-calendar.calendar[<ref>]`, the ref of the mission
 * resource.
 *
 *   list_calendars             calendar[<refs>].R
 *   list_events, search_events calendar[c].event[*].R
 *   get_event                  calendar[c].event[e].R
 *   suggest_time               free-busy.R
 *   create_event               calendar[c].event.W           (+ guests[z].W per zone invited)
 *   update_event               calendar[c].event[e].W        (+ guests[z].W, + event[e].notify.W)
 *   delete_event               calendar[c].event[e].delete.W (+ event[e].notify.W)
 *   respond_to_event           calendar[c].event[e].response.W
 *
 * `notify` is emitted unless the call sets `sendUpdates: none`: Google
 * then emails the event's current guests, whom the gateway cannot see before
 * the call.
 */

import {
  identSegment,
  type ClassifyOutcome,
  type Resource,
  type Slice,
  type SliceSegment,
} from '@vaubaan/plugin-sdk';

import { readCalendarCall, type CalendarCall } from './call.ts';
import { BARE_TOOL, PROVIDER_ID } from './identity.ts';

const name = (value: string): SliceSegment => ({ kind: 'name', value });
const ident = (value: string): SliceSegment => identSegment(value);
const ANY: SliceSegment = { kind: 'ident', value: '*' };

function slice(action: 'R' | 'W', path: readonly SliceSegment[]): Slice {
  return { provider: PROVIDER_ID, path, action };
}

/** The slices of a call that `readCalendarCall` accepted. */
export function slicesOf(call: CalendarCall): Slice[] {
  if (call.kind === 'list-calendars') {
    const refs = call.calendars.map((c) => c.ref);
    const [only] = refs;
    const calendars: SliceSegment =
      refs.length === 1 && only !== undefined ? ident(only) : { kind: 'list', values: refs };
    return [slice('R', [name('calendar'), calendars])];
  }
  if (call.bare === BARE_TOOL.suggestTime) return [slice('R', [name('free-busy')])];

  if (call.calendar === null) throw new Error(`${PROVIDER_ID}: '${call.tool}' names no calendar`);
  const root: readonly SliceSegment[] = [name('calendar'), ident(call.calendar)];
  const event = call.event === null ? ANY : ident(call.event);
  const guests = call.guests.map((zone) => slice('W', [...root, name('guests'), ident(zone)]));
  const notify = call.notifiesGuests
    ? [slice('W', [...root, name('event'), event, name('notify')])]
    : [];

  switch (call.bare) {
    case BARE_TOOL.listEvents:
    case BARE_TOOL.searchEvents:
    case BARE_TOOL.getEvent:
      return [slice('R', [...root, name('event'), event])];
    case BARE_TOOL.createEvent:
      return [slice('W', [...root, name('event')]), ...guests];
    case BARE_TOOL.updateEvent:
      return [slice('W', [...root, name('event'), event]), ...guests, ...notify];
    case BARE_TOOL.deleteEvent:
      return [slice('W', [...root, name('event'), event, name('delete')]), ...notify];
    case BARE_TOOL.respondToEvent:
      return [slice('W', [...root, name('event'), event, name('response')])];
    default:
      throw new Error(`${PROVIDER_ID}: '${call.tool}' has no slice mapping`);
  }
}

export function classifyGoogleCalendar(
  tool: string,
  args: Readonly<Record<string, unknown>>,
  resources: readonly Resource[],
): ClassifyOutcome {
  const read = readCalendarCall(tool, args, resources);
  if ('denied' in read) return read;
  return { slices: slicesOf(read.call) };
}
