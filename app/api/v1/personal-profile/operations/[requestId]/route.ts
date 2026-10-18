import { personalProfileResponse } from "@/lib/personalProfileApi";
export const dynamic="force-dynamic";
export async function GET(request:Request,context:{params:Promise<{requestId:string}>}){return personalProfileResponse(request,"operation",1,context.params);}
