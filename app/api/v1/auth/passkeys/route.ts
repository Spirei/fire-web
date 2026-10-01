import { readPasskeys, removePasskey, securityResponse } from "@/lib/appSecurity";
export async function GET(request: Request) { return securityResponse(() => readPasskeys(request),request); }
export async function DELETE(request: Request) { return securityResponse(() => removePasskey(request),request); }
