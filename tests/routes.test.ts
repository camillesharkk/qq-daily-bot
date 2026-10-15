import { afterEach, describe, expect, it } from "vitest";
import { POST } from "@/app/api/admin/test-send/route";
import { GET as cron } from "@/app/api/cron/daily/route";
import { GET as health } from "@/app/api/health/route";
import { clearAccessTokenCache } from "@/lib/qq/token";

const ENV_KEYS = [
  "QQ_APP_ID",
  "QQ_APP_SECRET",
  "QQ_GROUP_OPENID",
  "QQ_API_BASE",
  "CRON_SECRET",
  "ADMIN_TOKEN",
  "OPENAI_API_KEY",
  "OPENAI_MODEL",
  "DAILY_MESSAGE",
  "REPORT_SOURCE_URL",
  "REPORT_SOURCE_TOKEN",
] as const;

describe("http routes", () => {
  const originalFetch = globalThis.fetch;
  const saved = new Map<string, string | undefined>();

  afterEach(() => {
    globalThis.fetch = originalFetch;
    clearAccessTokenCache();
    for (const key of ENV_KEYS) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    saved.clear();
  });

  function saveEnv(): void {
    for (const key of ENV_KEYS) saved.set(key, process.env[key]);
  }

  function mockQq(sent: Array<Record<string, unknown>>): void {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("getAppAccessToken")) {
        return Response.json({ access_token: "test-token", expires_in: 7200 });
      }
      sent.push({
        url,
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return Response.json({ id: "msg-1" });
    }) as typeof fetch;
  }

  it("returns a health payload without environment values", async () => {
    saveEnv();
    process.env.QQ_APP_SECRET = "test-app-secret";
    process.env.QQ_GROUP_OPENID = "group-secret";
    const response = await health();
    const body: unknown = await response.json();
    expect(response.status).toBe(200);
    expect(body).toEqual({ ok: true, service: "qq-daily-bot" });
    expect(JSON.stringify(body)).not.toContain("test-app-secret");
    expect(JSON.stringify(body)).not.toContain("group-secret");
  });

  it("does not generate a report or call QQ when nothing is saved", async () => {
    saveEnv();
    process.env.CRON_SECRET = "test-cron-secret";
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.OPENAI_MODEL = "gpt-test";
    process.env.DAILY_MESSAGE = "must-not-send";
    const previousDatabase = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    let calls = 0;
    globalThis.fetch = (() => {
      calls += 1;
      return Promise.resolve(Response.json({}));
    }) as typeof fetch;

    const denied = await cron(new Request("https://example.com/api/cron/daily"));
    expect(denied.status).toBe(401);
    const missing = await cron(
      new Request("https://example.com/api/cron/daily", {
        headers: { authorization: "Bearer test-cron-secret" },
      }),
    );
    const body: unknown = await missing.json();
    expect(missing.status).toBe(200);
    expect(body).toMatchObject({ ok: false, status: "unavailable" });
    expect(calls).toBe(0);
    expect(JSON.stringify(body)).not.toContain("test-cron-secret");
    expect(JSON.stringify(body)).not.toContain("must-not-send");
    expect(JSON.stringify(body)).not.toContain("sk-test");
    if (previousDatabase === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabase;
  });

  it("sends the admin test message only to the server group", async () => {
    saveEnv();
    process.env.ADMIN_TOKEN = "test-admin-token";
    process.env.QQ_APP_ID = "test-app-id";
    process.env.QQ_APP_SECRET = "test-app-secret";
    process.env.QQ_API_BASE = "https://sandbox.api.sgroup.qq.com";
    process.env.QQ_GROUP_OPENID = "server-group";
    const denied = await POST(
      new Request("https://example.com/api/admin/test-send", {
        method: "POST",
        body: JSON.stringify({ content: "hi", group_openid: "attacker-group" }),
      }),
    );
    expect(denied.status).toBe(401);

    const sent: Array<Record<string, unknown>> = [];
    mockQq(sent);
    const response = await POST(
      new Request("https://example.com/api/admin/test-send", {
        method: "POST",
        headers: { authorization: "Bearer test-admin-token", "content-type": "application/json" },
        body: JSON.stringify({ content: "测试消息", group_openid: "attacker-group" }),
      }),
    );
    const body: unknown = await response.json();
    expect(response.status).toBe(200);
    expect(body).toEqual({ ok: true, segments: 1 });
    expect(JSON.stringify(body)).not.toContain("server-group");
    expect(String(sent[0]?.url)).toContain("server-group");
    expect(String(sent[0]?.url)).not.toContain("attacker-group");
    expect((sent[0]?.body as { content?: string }).content).toBe("测试消息");

    const fallbackSent: Array<Record<string, unknown>> = [];
    mockQq(fallbackSent);
    const fallback = await POST(
      new Request("https://example.com/api/admin/test-send", {
        method: "POST",
        headers: { authorization: "Bearer test-admin-token" },
      }),
    );
    expect(fallback.status).toBe(200);
    expect((fallbackSent[0]?.body as { content?: string }).content).toBe("QQ日报机器人测试成功。");
  });
});
