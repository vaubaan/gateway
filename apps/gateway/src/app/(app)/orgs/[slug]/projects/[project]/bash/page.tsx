import { redirect } from 'next/navigation';

export default async function BashRedirect({
  params,
}: {
  params: Promise<{ slug: string; project: string }>;
}) {
  const { slug, project } = await params;
  redirect(`/orgs/${slug}/projects/${project}/bindings/new`);
}
