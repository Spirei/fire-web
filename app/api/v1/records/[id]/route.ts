import { recordsResponse } from "@/lib/recordsApi";
type Context = { params: Promise<{ id: string }> };
export const dynamic = "force-dynamic";
export function GET(request: Request, { params }: Context) { return recordsResponse(request, "record", params); }
export function PUT(request: Request, { params }: Context) { return recordsResponse(request, "record", params); }
export function DELETE(request: Request, { params }: Context) { return recordsResponse(request, "record", params); }
