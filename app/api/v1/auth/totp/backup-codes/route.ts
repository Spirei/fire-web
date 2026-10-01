import { mutateTotp, securityResponse } from "@/lib/appSecurity";
export async function POST(request: Request) { return securityResponse(() => mutateTotp(request,"backup-codes"),request); }
