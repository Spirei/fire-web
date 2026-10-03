import { recordsResponse } from "@/lib/recordsApi";
type Context = { params: Promise<{ id: string }> };
export function PUT(request: Request, { params }: Context) { return recordsResponse(request, "record", params, true); }
export function DELETE(request: Request, { params }: Context) { return recordsResponse(request, "record", params, true); }
