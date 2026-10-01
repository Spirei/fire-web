import { appConfiguration } from "@/lib/appConfiguration";
export async function GET(request:Request) { return appConfiguration(request,1); }
