import { requestEmailVerification, securityResponse } from "@/lib/appSecurity";
export async function POST(request: Request) { return securityResponse(() => requestEmailVerification(request),request); }
