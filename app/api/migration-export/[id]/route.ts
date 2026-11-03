import { migrationExportFailure, migrationExportStatus } from "@/lib/migrationExport";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) { try { return await migrationExportStatus(request, (await context.params).id); } catch (error) { return migrationExportFailure(error); } }
