import { exchangeCode, PUBLIC_ORIGIN } from "@/lib/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const form = new URLSearchParams(await request.text());
  if (form.get("grant_type") !== "authorization_code" || form.get("resource") !== PUBLIC_ORIGIN) {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }
  const code = form.get("code");
  const verifier = form.get("code_verifier");
  const clientId = form.get("client_id");
  const redirectUri = form.get("redirect_uri");
  if (!code || !verifier || !clientId || !redirectUri) {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }
  const token = exchangeCode({ code, verifier, clientId, redirectUri });
  if (!token) return Response.json({ error: "invalid_grant" }, { status: 400 });
  return Response.json({ access_token: token, token_type: "Bearer", expires_in: 30 * 24 * 60 * 60, scope: "daily" });
}
