import { protectedResourceMetadata } from "@/lib/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(): Response {
  return Response.json(protectedResourceMetadata());
}
