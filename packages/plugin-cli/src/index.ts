/**
 * `@vaubaan/plugin-cli` — what a plugin author runs, as a library (the command line is
 * `cli.ts`). Spec plugin-authoring.
 */

export {
  ARCHIVE_MANIFEST_FILE,
  ARCHIVE_MANIFEST_FORMAT,
  ArchiveError,
  SDK_PACKAGE,
  archivePackage,
  buildArchive,
  manifestOf,
  notBundleableReason,
  outsideManifest,
  resolveSdkVersion,
} from './archive.ts';
export type {
  ArchiveManifest,
  ArchivePackage,
  BuildArchiveOptions,
  BuildArchiveResult,
  PluginPackage,
} from './archive.ts';
export { parseCommand, run, USAGE } from './cli.ts';
export type { Command } from './cli.ts';
