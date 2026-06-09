import { redirect } from 'next/navigation';

export default async function SshRedirect({
  params,
}: {
  params: Promise<{ slug: string; project: string }>;
}) {
  const { slug, project } = await params;
  redirect(`/orgs/${slug}/projects/${project}/bindings/new`);
}
