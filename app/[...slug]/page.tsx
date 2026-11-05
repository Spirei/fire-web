import { notFound } from "next/navigation";

export default async function SlugPage({ params }: { params: Promise<{ slug: string[] }> }) {
  const { slug } = await params;
  if ((slug.length === 1 && slug[0] === "attachments") || (slug[0] === "api" && slug[1] === "attachments")) notFound();
  return null;
}
