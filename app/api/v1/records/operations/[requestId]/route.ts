import { recordsResponse } from "@/lib/recordsApi";
export const dynamic = "force-dynamic";
export function GET(request: Request, { params }: { params: Promise<{ requestId: string }> }) {
  return recordsResponse(request, "operation", params);
}
