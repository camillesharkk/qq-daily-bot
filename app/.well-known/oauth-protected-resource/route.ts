import { PUBLIC_ORIGIN } from "@/lib/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(): Response {
  return Response.json({
    resource: PUBLIC_ORIGIN,
    authorization_servers: [PUBLIC_ORIGIN],
    scopes_supported: ["daily"],
    bearer_methods_supported: ["header"],
  });
}
