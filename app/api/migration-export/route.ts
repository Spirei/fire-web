import { migrationExportFailure, migrationExportPreflight, migrationExportStart } from "@/lib/migrationExport";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET(request: Request) { try { return await migrationExportPreflight(request); } catch (error) { return migrationExportFailure(error); } }
export async function POST(request: Request) { try { return await migrationExportStart(request); } catch (error) { return migrationExportFailure(error); } }
