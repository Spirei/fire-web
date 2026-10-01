import { securityGrant, securityResponse, SecurityError } from "@/lib/appSecurity";
export async function POST(request: Request) { return securityResponse(() => { securityGrant(request,true); throw new SecurityError("原生通行密钥关联域名尚未核验",50301,503); },request); }
