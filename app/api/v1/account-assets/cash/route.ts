import { tradingResponse } from "@/lib/appTradingApi";
export const dynamic = "force-dynamic";
export async function GET(request: Request) { return tradingResponse(request, "cash"); }
export async function POST(request: Request) { return tradingResponse(request, "cash"); }
