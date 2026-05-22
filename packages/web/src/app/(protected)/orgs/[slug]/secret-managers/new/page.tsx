/**
 * `/orgs/:slug/secret-managers/new` — Connect Infisical wizard.
 *
 * Server component. Loads the candidate recipient list
 * (org_admins ∪ runner_pk-when-present) from the DB and hands it to
 * the client wizard. The wizard does the seal in-tab and POSTs the
 * sealed blob to `/api/.../secret-managers`.
 *
 * Spec §11.1, §5.2 ("Bootstrap auth Infisical"). Phase 5 Wave B.
 *
 * For Phase 5 we compute "org admins" as the simple list of
 * `org_members.role='admin' ∪ role='owner'` joined with their
 * `user_crypto_keys`. The runner X25519 pubkey isn't deployed yet
 * (Phase 6+), so we omit it for now — that matches Phase 2's
 * recipient-defaults stub.
 */

import { notFound } from 'next/navigation';
import type { ReactElement } from 'react';

import {
  ConnectInfisicalWizard,
  type WizardRecipient,
} from '@/components/secret-managers/ConnectInfisicalWizard';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

interface PageProps {
  readonly params: Promise<{ readonly slug: string }>;
}

interface OrgRow {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
}

interface MemberRow {
  readonly user_id: string;
  readonly role: string;
}

interface KeyRow {
  readonly user_id: string;
  readonly public_key: string | Uint8Array;
  readonly fingerprint: string;
}

interface FilterChain {
  eq(
    col: string,
    val: string,
  ): FilterChain & Promise<{ data: unknown; error: { message: string } | null }>;
  in(
    col: string,
    vals: ReadonlyArray<string>,
  ): Promise<{ data: unknown; error: { message: string } | null }>;
  maybeSingle(): Promise<{ data: unknown; error: { message: string } | null }>;
  order(
    col: string,
    opts: { ascending: boolean },
  ): Promise<{ data: unknown; error: { message: string } | null }>;
}

interface SupabaseLike {
  from(table: string): {
    select(cols: string): FilterChain;
  };
}

function pubKeyToBase64(value: string | Uint8Array): string {
  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString('base64');
  }
  if (typeof value === 'string' && value.startsWith('\\x')) {
    return Buffer.from(value.slice(2), 'hex').toString('base64');
  }
  // Already base64 (PostgREST option). Trust it.
  return value;
}

export default async function NewSecretManagerPage({ params }: PageProps): Promise<ReactElement> {
  const { slug } = await params;
  const supabase = (await createSupabaseServerClient()) as unknown as SupabaseLike;

  const { data: orgRaw } = await supabase
    .from('organizations')
    .select('id, slug, name')
    .eq('slug', slug)
    .maybeSingle();
  const org = orgRaw as OrgRow | null;
  if (!org) notFound();

  const { data: membersRaw } = await supabase
    .from('org_members')
    .select('user_id, role')
    .eq('organization_id', org.id);
  const members = (membersRaw as ReadonlyArray<MemberRow> | null) ?? [];
  const adminIds = members
    .filter((m) => m.role === 'admin' || m.role === 'owner')
    .map((m) => m.user_id);

  let recipients: WizardRecipient[] = [];
  if (adminIds.length > 0) {
    const { data: keysRaw } = await supabase
      .from('user_crypto_keys')
      .select('user_id, public_key, fingerprint')
      .in('user_id', adminIds);
    const keys = (keysRaw as ReadonlyArray<KeyRow> | null) ?? [];
    recipients = keys.map((k) => ({
      user_id: k.user_id,
      fingerprint: k.fingerprint,
      public_key_b64: pubKeyToBase64(k.public_key),
    }));
  }

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
      <header>
        <h1 className="text-xl font-semibold">Connect Infisical to {org.name}</h1>
        <p className="text-xs text-muted">
          The machine-identity credential pair is sealed in-tab for the org admins. Vauban never
          sees the cleartext.
        </p>
      </header>
      <ConnectInfisicalWizard orgSlug={org.slug} recipients={recipients} />
    </main>
  );
}
