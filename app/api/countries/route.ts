import { NextResponse } from "next/server";
import { allCountryCatalog } from "@/lib/countryCatalog";

export const dynamic = "force-static";

export async function GET() {
  return NextResponse.json({ countries: allCountryCatalog() });
}
