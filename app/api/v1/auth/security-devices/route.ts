import { readDevices, removeDevice, securityResponse } from "@/lib/appSecurity";
export async function GET(request: Request) { return securityResponse(() => readDevices(request),request); }
export async function DELETE(request: Request) { return securityResponse(() => removeDevice(request),request); }
