import { authorizationCode, PUBLIC_ORIGIN, redirectAllowed } from "@/lib/oauth";
import { isBearerAuthorized } from "@/lib/auth";
import { optionalEnv } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function page(fields: Record<string, string>, error = ""): Response {
  const hidden = Object.entries(fields)
    .map(([key, value]) => `<input type="hidden" name="${key}" value="${value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;")}">`)
    .join("");
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>连接日报</title><body><main><h1>连接 ChatGPT</h1><p>输入管理密钥完成一次性授权。密钥不会出现在网址里。</p>${error ? `<p>${error}</p>` : ""}<form method="post">${hidden}<label>管理密钥 <input type="password" name="password" autocomplete="off"></label><button type="submit">授权</button></form></main></body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

function fieldsFrom(source: URLSearchParams): Record<string, string> | null {
  const names = ["client_id", "redirect_uri", "state", "code_challenge", "code_challenge_method", "resource"] as const;
  const fields: Record<string, string> = {};
  for (const name of names) {
    const value = source.get(name);
    if (!value) return null;
    fields[name] = value;
  }
  return fields;
}

export async function GET(request: Request): Promise<Response> {
  const fields = fieldsFrom(new URL(request.url).searchParams);
  if (!fields) return new Response("缺少授权参数", { status: 400 });
  return page(fields);
}

export async function POST(request: Request): Promise<Response> {
  const form = await request.formData();
  const fields = fieldsFrom(new URLSearchParams([...form].flatMap(([key, value]) => typeof value === "string" ? [[key, value]] : [])));
  if (!fields) return new Response("缺少授权参数", { status: 400 });
  const password = form.get("password");
  if (typeof password !== "string" || !isBearerAuthorized(`Bearer ${password}`, optionalEnv("ADMIN_TOKEN"))) {
    return page(fields, "密钥不正确");
  }
  if (fields.code_challenge_method !== "S256" || fields.resource !== PUBLIC_ORIGIN) {
    return new Response("授权参数无效", { status: 400 });
  }
  if (!(await redirectAllowed(fields.client_id, fields.redirect_uri))) {
    return new Response("回调地址无效", { status: 400 });
  }
  const code = authorizationCode({
    clientId: fields.client_id,
    redirectUri: fields.redirect_uri,
    challenge: fields.code_challenge,
  });
  const target = new URL(fields.redirect_uri);
  target.searchParams.set("code", code);
  target.searchParams.set("state", fields.state);
  target.searchParams.set("iss", PUBLIC_ORIGIN);
  return Response.redirect(target, 302);
}
