import { notFound } from 'next/navigation';
import { NeedsUser } from '@/components/auth/NeedsUser';
import { PageHeader, ButtonLink } from '@/components/ui';
import { currentUser } from '@/lib/auth/session';
import { PermissionsEditor } from '../permissions-editor';

export const dynamic = 'force-dynamic';
export default async function PermissionsPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await currentUser();
  if (!session) return <NeedsUser />;
  const { id } = await params;
  const data = await session.root.missions.service.permissionOptions(session.user, id);
  if (!data) notFound();
  return (
    <>
      <PageHeader title={`Modify permissions · ${data.missionName}`} />
      <PermissionsEditor data={data} />
      <ButtonLink href={`/missions/${id}`} variant="ghost">
        Back to mission
      </ButtonLink>
    </>
  );
}
