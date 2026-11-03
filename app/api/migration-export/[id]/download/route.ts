import { migrationExportDownload, migrationExportFailure } from "@/lib/migrationExport";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) { try { return await migrationExportDownload(request, (await context.params).id); } catch (error) { return migrationExportFailure(error); } }
