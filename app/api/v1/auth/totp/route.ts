import { readTotp, securityResponse } from "@/lib/appSecurity";
export async function GET(request: Request) { return securityResponse(() => readTotp(request),request); }
