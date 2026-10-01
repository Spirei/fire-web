import { verifyEmail, securityResponse } from "@/lib/appSecurity";
export async function POST(request: Request) { return securityResponse(() => verifyEmail(request),request); }
