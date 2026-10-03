import { resourceLibraryResponse, type ResourceContext } from "@/lib/resourceLibraryApi";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export function GET(request: Request, context: ResourceContext) { return resourceLibraryResponse(request, context, 2); }
export function POST(request: Request, context: ResourceContext) { return resourceLibraryResponse(request, context, 2); }
export function DELETE(request: Request, context: ResourceContext) { return resourceLibraryResponse(request, context, 2); }
