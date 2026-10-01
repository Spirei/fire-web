import { readEmailVerification, securityResponse } from "@/lib/appSecurity";
export async function GET(request: Request) { return securityResponse(() => readEmailVerification(request),request); }
