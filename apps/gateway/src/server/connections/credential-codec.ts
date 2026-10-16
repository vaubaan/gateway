/**
 * The clear form of a stored credential: the plugin-facing `CredentialSecret`
 * serialized as JSON. This text is what `store.connections` seals with the
 * connection id as associated data (spec §6 "encryption at rest"); it exists
 * in memory only between `getCredential()` and the upstream call.
 */
import { CREDENTIAL_KINDS, type CredentialKind } from '@vaubaan/shared';
import type { CredentialSecret } from '@vaubaan/plugin-sdk';

export class CredentialFormatError extends Error {
  constructor(message: string) {
    super(`stored credential: ${message}`);
    this.name = 'CredentialFormatError';
  }
}

export function serializeSecret(secret: CredentialSecret): string {
  return JSON.stringify(secret);
}

export function parseSecret(text: string): CredentialSecret {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new CredentialFormatError('not JSON');
  }
  if (!isRecord(raw)) throw new CredentialFormatError('not an object');
  const kind = raw.kind;
  if (typeof kind !== 'string' || !(CREDENTIAL_KINDS as readonly string[]).includes(kind)) {
    throw new CredentialFormatError('unknown kind');
  }
  const metadata = stringRecord(raw.metadata, 'metadata');
  switch (kind as CredentialKind) {
    case 'api-key':
      return { kind: 'api-key', fields: stringRecord(raw.fields, 'fields'), metadata };
    case 'oauth2':
      return {
        kind: 'oauth2',
        accessToken: requireString(raw.accessToken, 'accessToken'),
        refreshToken: optionalString(raw.refreshToken, 'refreshToken'),
        expiresAt: optionalString(raw.expiresAt, 'expiresAt'),
        scopes: stringList(raw.scopes, 'scopes'),
        metadata,
      };
    case 'app-install':
      return {
        kind: 'app-install',
        installationId: requireString(raw.installationId, 'installationId'),
        metadata,
      };
    case 'ssh-key':
      return {
        kind: 'ssh-key',
        privateKeyPem: requireString(raw.privateKeyPem, 'privateKeyPem'),
        publicKey: requireString(raw.publicKey, 'publicKey'),
        fields: stringRecord(raw.fields, 'fields'),
        metadata,
      };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new CredentialFormatError(`'${name}' is missing`);
  }
  return value;
}

function optionalString(value: unknown, name: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new CredentialFormatError(`'${name}' is not a string`);
  return value;
}

function stringList(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new CredentialFormatError(`'${name}' is not a list of strings`);
  }
  return value as string[];
}

function stringRecord(value: unknown, name: string): Record<string, string> {
  if (!isRecord(value)) throw new CredentialFormatError(`'${name}' is not an object`);
  const out: Record<string, string> = {};
  for (const [key, v] of Object.entries(value)) {
    if (typeof v !== 'string') throw new CredentialFormatError(`'${name}.${key}' is not a string`);
    out[key] = v;
  }
  return out;
}
