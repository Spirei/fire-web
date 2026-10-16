import { emailRegistration } from "@/lib/emailRegistration";
export async function POST(request: Request) { return emailRegistration(request, "confirm"); }
