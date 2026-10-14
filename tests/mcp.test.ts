import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as mcp } from "@/app/api/mcp/route";
import { GET as resource } from "@/app/.well-known/oauth-protected-resource/route";
import { GET as server } from "@/app/.well-known/oauth-authorization-server/route";
import { POST as token } from "@/app/oauth/token/route";
import { readReadyReport } from "@/lib/daily-store";
import { useQueryForTests } from "@/lib/db";
import { authorizationCode, MCP_RESOURCE, PUBLIC_ORIGIN, verifyAccessToken } from "@/lib/oauth";
import { clearAccessTokenCache } from "@/lib/qq/token";
import { createMemoryQuery } from "./memory-db";

const DATE = "2026-10-14";

describe("chatgpt mcp", () => {
  const originalFetch = globalThis.fetch;
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of ["ADMIN_TOKEN", "QQ_APP_ID", "QQ_APP_SECRET", "QQ_API_BASE", "QQ_GROUP_OPENID", "DATABASE_URL"]) {
      saved.set(key, process.env[key]);
    }
    useQueryForTests(createMemoryQuery());
    process.env.ADMIN_TOKEN = "test-admin-token";
    process.env.QQ_APP_ID = "test-app-id";
    process.env.QQ_APP_SECRET = "test-app-secret";
    process.env.QQ_API_BASE = "https://sandbox.api.sgroup.qq.com";
    process.env.QQ_GROUP_OPENID = "server-group";
    delete process.env.DATABASE_URL;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    clearAccessTokenCache();
    useQueryForTests(null);
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    saved.clear();
  });

  async function bearer(): Promise<string> {
    const verifier = "verifier";
    const code = authorizationCode({
      clientId: "https://chatgpt.com/oauth/client.json",
      redirectUri: "https://chatgpt.com/connector_platform_oauth_redirect",
      challenge: createHash("sha256").update(verifier).digest("base64url"),
      resource: PUBLIC_ORIGIN,
    });
    const response = await token(new Request("https://bot.arizonanotaryprep.com/oauth/token", {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        client_id: "https://chatgpt.com/oauth/client.json",
        redirect_uri: "https://chatgpt.com/connector_platform_oauth_redirect",
        resource: PUBLIC_ORIGIN,
      }),
    }));
    const body = await response.json() as { access_token: string; refresh_token: string };
    const carried = JSON.parse(JSON.stringify({ access: body.access_token })).access as string;
    expect(verifyAccessToken(`Bearer ${carried}`)).toBe(true);
    expect(verifyAccessToken(`Bearer ${body.refresh_token}`)).toBe(false);
    return carried;
  }

  function call(name: string, args: Record<string, string>, access = ""): Promise<Response> {
    return mcp(new Request("https://bot.arizonanotaryprep.com/api/mcp", {
      method: "POST",
      headers: access ? { authorization: `Bearer ${access}` } : {},
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    }));
  }

  it("advertises OAuth and rejects an unauthenticated save", async () => {
    const metadata = await (await server()).json() as { code_challenge_methods_supported: string[] };
    expect(metadata.code_challenge_methods_supported).toEqual(["S256"]);
    const resourceBody = await (await resource()).json() as { resource: string };
    expect(resourceBody.resource).toBe(MCP_RESOURCE);
    const denied = await call("save_daily_report", { date: DATE, content: "原文" });
    expect(denied.status).toBe(401);
    expect(denied.headers.get("www-authenticate")).toContain("oauth-protected-resource");
  });

  it("saves through an access token and does not send the same report twice", async () => {
    const access = await bearer();
    const sent: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("api.openai.com") || url.includes("api.deepseek.com")) throw new Error("model must not be called");
      if (url.includes("getAppAccessToken")) return Response.json({ access_token: "test-token", expires_in: 7200 });
      sent.push(JSON.parse(String(init?.body)).content as string);
      return Response.json({ id: "msg-1" });
    }) as typeof fetch;

    const saved = await call("save_daily_report", { date: DATE, content: "原文 https://example.com/a" }, access);
    const body = await saved.json() as { result: { isError: boolean; content: Array<{ text: string }> } };
    expect(body.result.isError).toBe(false);
    expect(JSON.parse(body.result.content[0].text).status).toBe("sent");
    expect(sent).toEqual(["原文 （来源：example.com）"]);
    await expect(readReadyReport(DATE)).resolves.toBe("原文 https://example.com/a");

    const again = await call("save_daily_report", { date: DATE, content: "原文 https://example.com/a" }, access);
    const againBody = await again.json() as { result: { content: Array<{ text: string }> } };
    expect(JSON.parse(againBody.result.content[0].text).status).toBe("already_sent");
    expect(sent).toHaveLength(1);
  });
});
