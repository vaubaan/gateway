/**
 * Classifier of the `onedrive` service: `(tool, args, resources) → slices`.
 *
 * Spec     : docs/spec/gateway-risk-model.md §3, §7 ; docs/spec/vaubaan-gateway.md
 *            §10 ("a classification error is a security hole").
 * Handbook : docs/handbook/services/onedrive.md.
 *
 * Pure. The call is read once by `readDriveCall`; `d` is the drive ref
 * (`[*]` when the slice grammar cannot carry it).
 *
 *   list_folder     drive[d].folder[f].R
 *   search_files    drive[d].file[*].R
 *   read_file       drive[d].file[id].content.R
 *   upload_file     drive[d].file.W
 *   create_folder   drive[d].folder.W
 */

import {
  ANY_IDENT,
  identSegment,
  type ClassifyOutcome,
  type Resource,
  type Slice,
  type SliceSegment,
} from '@vaubaan/plugin-sdk';

import { readDriveCall } from './call.ts';
import { SERVICE_ID, TOOL } from './identity.ts';

const name = (value: string): SliceSegment => ({ kind: 'name', value });
const ident = (value: string | null): SliceSegment =>
  value === null ? ANY_IDENT : identSegment(value);

function slice(action: 'R' | 'W', path: readonly SliceSegment[]): Slice {
  return { service: SERVICE_ID, path, action };
}

export function classifyOneDrive(
  tool: string,
  args: Readonly<Record<string, unknown>>,
  resources: readonly Resource[],
): ClassifyOutcome {
  const read = readDriveCall(tool, args, resources);
  if ('denied' in read) return read;
  const { call } = read;
  const root = [name('drive'), ident(call.drive.ref)];
  switch (call.tool) {
    case TOOL.listFolder:
      return { slices: [slice('R', [...root, name('folder'), ident(call.folder)])] };
    case TOOL.searchFiles:
      return { slices: [slice('R', [...root, name('file'), ANY_IDENT])] };
    case TOOL.readFile:
      return {
        slices: [slice('R', [...root, name('file'), ident(call.file), name('content')])],
      };
    case TOOL.uploadFile:
      return { slices: [slice('W', [...root, name('file')])] };
    case TOOL.createFolder:
      return { slices: [slice('W', [...root, name('folder')])] };
    default:
      return { denied: `unknown tool '${tool}'` };
  }
}
