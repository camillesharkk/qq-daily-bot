import { afterEach, describe, expect, it } from "vitest";
import { POST } from "@/app/api/admin/test-send/route";
import { GET as cron } from "@/app/api/cron/daily/route";
import { GET as health } from "@/app/api/health/route";
import { resetDailyStore } from "@/lib/daily-store";
import { shanghaiDate } from "@/lib/date";
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
    resetDailyStore();
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

  it("protects the cron route and omits the report text from the response", async () => {
    saveEnv();
    process.env.CRON_SECRET = "test-cron-secret";
    process.env.QQ_APP_ID = "test-app-id";
    process.env.QQ_APP_SECRET = "test-app-secret";
    process.env.QQ_API_BASE = "https://sandbox.api.sgroup.qq.com";
    process.env.QQ_GROUP_OPENID = "server-group";
    process.env.DAILY_MESSAGE = "unique-daily-body";
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_MODEL;
    delete process.env.REPORT_SOURCE_URL;

    const denied = await cron(new Request("https://example.com/api/cron/daily"));
    expect(denied.status).toBe(401);

    delete process.env.QQ_GROUP_OPENID;
    const unbound = await cron(
      new Request("https://example.com/api/cron/daily", {
        headers: { authorization: "Bearer test-cron-secret" },
      }),
    );
    expect(unbound.status).toBe(500);
    const unboundBody = await unbound.json();
    expect(unboundBody.error).toMatch(/QQ_GROUP_OPENID/);
    expect(JSON.stringify(unboundBody)).not.toContain("test-cron-secret");

    process.env.QQ_GROUP_OPENID = "server-group";
    const sent: Array<Record<string, unknown>> = [];
    mockQq(sent);
    const response = await cron(
      new Request("https://example.com/api/cron/daily", {
        headers: { authorization: "Bearer test-cron-secret" },
      }),
    );
    const body: unknown = await response.json();
    expect(response.status).toBe(200);
    expect(body).toEqual({ ok: true, segments: 1, date: shanghaiDate(), status: "sent" });
    expect(JSON.stringify(body)).not.toContain("unique-daily-body");
    expect(JSON.stringify(body)).not.toContain("server-group");
    expect(String(sent[0]?.url)).toContain("/v2/groups/server-group/messages");
    expect((sent[0]?.body as { content?: string }).content).toBe("unique-daily-body");
  });

  it("does not generate again after a failed send and does not send twice after success", async () => {
    saveEnv();
    process.env.CRON_SECRET = "test-cron-secret";
    process.env.QQ_APP_ID = "test-app-id";
    process.env.QQ_APP_SECRET = "test-app-secret";
    process.env.QQ_API_BASE = "https://sandbox.api.sgroup.qq.com";
    process.env.QQ_GROUP_OPENID = "server-group";
    process.env.DAILY_MESSAGE = "first-body";
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_MODEL;
    delete process.env.REPORT_SOURCE_URL;
    resetDailyStore();

    const sent: Array<Record<string, unknown>> = [];
    let failSend = true;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("getAppAccessToken")) {
        return Response.json({ access_token: "test-token", expires_in: 7200 });
      }
      if (failSend) return Response.json({ message: "denied", err_code: 40034105 }, { status: 400 });
      sent.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return Response.json({ id: "msg-1" });
    }) as typeof fetch;

    const failed = await cron(
      new Request("https://example.com/api/cron/daily", {
        headers: { authorization: "Bearer test-cron-secret" },
      }),
    );
    expect(failed.status).toBe(500);
    process.env.DAILY_MESSAGE = "second-body";
    failSend = false;
    const retried = await cron(
      new Request("https://example.com/api/cron/daily", {
        headers: { authorization: "Bearer test-cron-secret" },
      }),
    );
    expect(retried.status).toBe(200);
    expect((sent[0]?.body as { content?: string }).content).toBe("first-body");
    const skipped = await cron(
      new Request("https://example.com/api/cron/daily", {
        headers: { authorization: "Bearer test-cron-secret" },
      }),
    );
    await expect(skipped.json()).resolves.toMatchObject({ status: "already_sent", segments: 0 });
    expect(sent).toHaveLength(1);
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
