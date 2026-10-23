import {tradeCorrectionResponse} from "@/lib/tradeCorrectionApi";
export const dynamic="force-dynamic";
export async function POST(request:Request){return tradeCorrectionResponse(request,true);}
