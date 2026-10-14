import { allowedResource, exchangeCode, exchangeRefresh } from "@/lib/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function issued(tokens: { accessToken: string; refreshToken: string; expiresIn: number }): Response {
  return Response.json({
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken,
    token_type: "Bearer",
    expires_in: tokens.expiresIn,
    scope: "daily offline_access",
  });
}

export async function POST(request: Request): Promise<Response> {
  const form = new URLSearchParams(await request.text());
  const resource = form.get("resource");
  if (resource && !allowedResource(resource)) return Response.json({ error: "invalid_target" }, { status: 400 });
  if (form.get("grant_type") === "refresh_token") {
    const refresh = form.get("refresh_token");
    if (!refresh) return Response.json({ error: "invalid_request" }, { status: 400 });
    const tokens = exchangeRefresh(refresh, resource);
    if (!tokens) return Response.json({ error: "invalid_grant" }, { status: 400 });
    return issued(tokens);
  }
  if (form.get("grant_type") !== "authorization_code" || !resource) {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }
  const code = form.get("code");
  const verifier = form.get("code_verifier");
  const clientId = form.get("client_id");
  const redirectUri = form.get("redirect_uri");
  if (!code || !verifier || !clientId || !redirectUri) {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }
  const tokens = exchangeCode({ code, verifier, clientId, redirectUri, resource });
  if (!tokens) return Response.json({ error: "invalid_grant" }, { status: 400 });
  return issued(tokens);
}
