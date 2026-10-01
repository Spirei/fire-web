import { appConfiguration } from "@/lib/appConfiguration";
export const dynamic="force-dynamic";
export async function GET(request:Request) { return appConfiguration(request,2); }
