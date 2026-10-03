import { recordsResponse } from "@/lib/recordsApi";
export const dynamic = "force-dynamic";
export function GET(request: Request) { return recordsResponse(request, "list"); }
export function POST(request: Request) { return recordsResponse(request, "list"); }
