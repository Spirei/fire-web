import { passwordRecovery } from "@/lib/appPasswordRecovery";
import { securityResponse } from "@/lib/appSecurity";
export async function POST(request: Request) { return securityResponse(() => passwordRecovery(request,"confirm")); }
