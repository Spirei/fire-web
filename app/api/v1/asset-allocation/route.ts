import { assetAllocationResponse } from "@/lib/assetAllocationApi";
export const dynamic = "force-dynamic";
export const GET = (request: Request) => assetAllocationResponse(request);
export const POST = (request: Request) => assetAllocationResponse(request);
export const PUT = (request: Request) => assetAllocationResponse(request);
export const DELETE = (request: Request) => assetAllocationResponse(request);
