import * as legacy from "@/app/api/v1/brokers/route";
import { appV2Response } from "@/lib/appApiV2";
import type { NextRequest } from "next/server";
export const dynamic="force-dynamic";
export async function GET(request:NextRequest) { return appV2Response(request,()=>legacy.GET(request)); }
