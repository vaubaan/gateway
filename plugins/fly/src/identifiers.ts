/**
 * The grammars of the `fly` plugin : one function per kind of identifier,
 * shared by `classify` and `execute` (ADR
 * plugin-identifiers-one-grammar-for-classify-and-execute). Each returns the
 * value or `null` ; a value outside its grammar is refused, never repaired.
 *
 * Where each value lands decides its grammar :
 *
 *   app name, machine / volume / snapshot id, secret name   one URL path segment
 *   hostname                                                one URL path segment (dotted)
 *   IP address                                              one URL path segment (IPv6 holds ':')
 *   org slug, network, region, volume name                  JSON body or query, never the path
 *   image reference                                         JSON body ; decides the image guard
 */

import { isIP } from 'node:net';

import { isRecord } from '@vaubaan/plugin-sdk';

import { DEFAULT_IMAGE_PREFIXES } from './identity.ts';

/** A Fly app name : lower-case letters, digits and inner hyphens, at most 63 characters. */
export const APP_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** A machine, volume or snapshot id : one path segment, no dot, no separator, no escape. */
export const PATH_IDENT = /^[A-Za-z0-9_-]{1,64}$/;

/** A secret name : an environment variable name. */
export const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** An organization slug, a private network name. */
export const SLUG = /^[a-z0-9][a-z0-9_-]{0,62}$/;

/** A Fly region code (`cdg`, `iad`). */
export const REGION = /^[a-z]{3}$/;

/** A volume name : letters, digits and underscores. */
export const VOLUME_NAME = /^[A-Za-z0-9_]{1,64}$/;

/** One DNS label, lower case : letters, digits, inner hyphens. */
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Maximum length of a hostname. */
const HOSTNAME_MAX = 253;

/** One repository path component of an image reference. */
const REPO_COMPONENT = '[a-z0-9]+(?:[._-][a-z0-9]+)*';
const REPOSITORY = `${REPO_COMPONENT}(?:/${REPO_COMPONENT})+`;

/**
 * An image reference the guard accepts : a repository (registry host first,
 * no port), an optional tag, and a mandatory sha256 digest.
 */
// nosemgrep: detect-redos -- every repetition of REPO_COMPONENT starts with a separator ([._-] or /) outside [a-z0-9], so a string splits one way only: linear, no backtracking (pinned by identifiers.test.ts)
export const PINNED_IMAGE = new RegExp(
  `^(${REPOSITORY})(?::([A-Za-z0-9_][A-Za-z0-9_.-]{0,127}))?@sha256:[a-f0-9]{64}$`,
);

/**
 * A prefix of allowed images : a registry host, then optional path
 * components, optionally ending with `/` (`ghcr.io/acme/app`,
 * `registry.fly.io/`). Matched at a path boundary (`imageRefusal`).
 */
// nosemgrep: detect-redos -- every repetition of REPO_COMPONENT starts with a separator ([._-] or /) outside [a-z0-9], so a string splits one way only: linear, no backtracking (pinned by identifiers.test.ts)
export const IMAGE_PREFIX = new RegExp(`^${REPO_COMPONENT}(?:/${REPO_COMPONENT})*/?$`);

/** The separator of the `image_prefixes` field and metadata. */
export const IMAGE_PREFIX_SEPARATOR = ',';

function matching(pattern: RegExp, value: unknown): string | null {
  return typeof value === 'string' && pattern.test(value) ? value : null;
}

export const appName = (value: unknown): string | null => matching(APP_NAME, value);
export const pathIdent = (value: unknown): string | null => matching(PATH_IDENT, value);
export const secretName = (value: unknown): string | null => matching(SECRET_NAME, value);
export const slug = (value: unknown): string | null => matching(SLUG, value);
export const region = (value: unknown): string | null => matching(REGION, value);
export const volumeName = (value: unknown): string | null => matching(VOLUME_NAME, value);

/** A hostname for a certificate : lower-case DNS labels, at least two, no wildcard. */
export function hostname(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > HOSTNAME_MAX) return null;
  const labels = value.split('.');
  if (labels.length < 2) return null;
  return labels.every((label) => DNS_LABEL.test(label)) ? value : null;
}

/** An IPv4 or IPv6 literal, as Fly lists it. */
export function ipAddress(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 45) return null;
  return isIP(value) === 0 ? null : value;
}

/**
 * The allowed image prefixes written in a field or in resource metadata :
 * comma-separated, each an `IMAGE_PREFIX`. An empty or absent value is the
 * default list ; one malformed entry refuses the whole value (`null`).
 */
export function imagePrefixesOf(value: unknown): readonly string[] | null {
  if (value === undefined || value === null) return DEFAULT_IMAGE_PREFIXES;
  if (typeof value !== 'string') return null;
  if (value.trim() === '') return DEFAULT_IMAGE_PREFIXES;
  const entries = value.split(IMAGE_PREFIX_SEPARATOR).map((entry) => entry.trim());
  return entries.every((entry) => IMAGE_PREFIX.test(entry)) ? entries : null;
}

/** Whether `repository` lies under `prefix` : equal, or below it at a path boundary. */
function under(repository: string, prefix: string): boolean {
  if (prefix.endsWith('/')) return repository.startsWith(prefix);
  return repository === prefix || repository.startsWith(`${prefix}/`);
}

/**
 * The image guard (handbook, Invariants, "Image guard") : an image runs with the app's secrets and
 * volume, so a machine may only run an image pinned by digest and under one
 * of the connection's prefixes. `null` when the image passes ; otherwise the
 * refusal the agent reads.
 */
export function imageRefusal(image: unknown, prefixes: readonly string[]): string | null {
  if (typeof image !== 'string' || image.length === 0) {
    return 'image: missing — name the image as <repository>@sha256:<digest>';
  }
  const match = PINNED_IMAGE.exec(image);
  if (!match) {
    return 'image: not pinned by digest — name the image as <repository>[:tag]@sha256:<64 hex digits>';
  }
  const repository = match[1]!;
  if (!prefixes.some((prefix) => under(repository, prefix))) {
    return `image: '${repository}' is not an image this connection may run (allowed: ${prefixes.join(', ')})`;
  }
  return null;
}

/**
 * Every image a machine config names : `image`, each container's `image`,
 * and each file's `image_config`. `null` when the config is not an object or
 * names no main image.
 */
export function imagesOfConfig(config: unknown): readonly unknown[] | null {
  if (!isRecord(config) || config.image === undefined) return null;
  const images: unknown[] = [config.image];
  if (config.containers !== undefined) {
    if (!Array.isArray(config.containers)) return null;
    for (const container of config.containers) {
      if (!isRecord(container)) return null;
      if (container.image !== undefined) images.push(container.image);
    }
  }
  if (config.files !== undefined) {
    if (!Array.isArray(config.files)) return null;
    for (const file of config.files) {
      if (!isRecord(file)) return null;
      if (file.image_config !== undefined) images.push(file.image_config);
    }
  }
  return images;
}

/** The refusal of the first image of `config` the guard does not accept ; `null` when all pass. */
export function configImageRefusal(config: unknown, prefixes: readonly string[]): string | null {
  const images = imagesOfConfig(config);
  if (!images) return 'config: expected a machine config object with an image';
  for (const image of images) {
    const refusal = imageRefusal(image, prefixes);
    if (refusal) return refusal;
  }
  return null;
}
