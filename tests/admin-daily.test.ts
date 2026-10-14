import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST } from "@/app/api/admin/daily/route";
import { readReadyReport, readSendState } from "@/lib/daily-store";
import { useQueryForTests } from "@/lib/db";
import { clearAccessTokenCache } from "@/lib/qq/token";
import { createMemoryQuery } from "./memory-db";

const DATE = "2026-10-14";

describe("admin daily page api", () => {
  const originalFetch = globalThis.fetch;
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of ["ADMIN_TOKEN", "QQ_APP_ID", "QQ_APP_SECRET", "QQ_API_BASE", "QQ_GROUP_OPENID", "DATABASE_URL", "OPENAI_API_KEY", "DEEPSEEK_API_KEY"]) {
      saved.set(key, process.env[key]);
    }
    useQueryForTests(createMemoryQuery());
    process.env.ADMIN_TOKEN = "test-admin-token";
    process.env.QQ_APP_ID = "test-app-id";
    process.env.QQ_APP_SECRET = "test-app-secret";
    process.env.QQ_API_BASE = "https://sandbox.api.sgroup.qq.com";
    process.env.QQ_GROUP_OPENID = "server-group";
    delete process.env.DATABASE_URL;
    delete process.env.OPENAI_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
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

  function call(action: string, content: string, token = "test-admin-token"): Promise<Response> {
    return POST(
      new Request("https://example.com/api/admin/daily", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ action, date: DATE, content }),
      }),
    );
  }

  it("rejects a missing token and does not put the token in the response", async () => {
    const denied = await call("preview", "原文 https://example.com/a", "");
    expect(denied.status).toBe(401);
    expect(JSON.stringify(await denied.json())).not.toContain("test-admin-token");
  });

  it("previews the QQ text without calling OpenAI, DeepSeek, or QQ", async () => {
    let calls = 0;
    globalThis.fetch = (() => {
      calls += 1;
      return Promise.resolve(Response.json({}));
    }) as typeof fetch;
    const response = await call("preview", "原文 https://example.com/a");
    const body = (await response.json()) as { segments: string[] };
    expect(response.status).toBe(200);
    expect(body.segments).toEqual(["原文 （来源：example.com）"]);
    expect(JSON.stringify(body)).not.toContain("https://");
    expect(calls).toBe(0);
  });

  it("saves the original text for the group daily command", async () => {
    const response = await call("save", "原文 https://example.com/a");
    expect(response.status).toBe(200);
    await expect(readReadyReport(DATE)).resolves.toBe("原文 https://example.com/a");
  });

  it("keeps the original after a rejected proactive send and does not send it twice", async () => {
    const sent: string[] = [];
    let failSend = true;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("api.openai.com") || url.includes("api.deepseek.com")) {
        throw new Error("model must not be called");
      }
      if (url.includes("getAppAccessToken")) return Response.json({ access_token: "test-token", expires_in: 7200 });
      if (failSend) return Response.json({ message: "denied", err_code: 40034105 }, { status: 400 });
      sent.push(JSON.parse(String(init?.body)).content as string);
      return Response.json({ id: "msg-1" });
    }) as typeof fetch;

    const failed = await call("send", "第一版 https://news.example/item");
    const failedBody = (await failed.json()) as { saved?: boolean; status?: string; errCode?: string };
    expect(failed.status).toBe(500);
    expect(failedBody).toMatchObject({ saved: true, status: "failed", errCode: "40034105" });
    await expect(readReadyReport(DATE)).resolves.toBe("第一版 https://news.example/item");
    await expect(readSendState(DATE, "server-group")).resolves.toBe("failed");

    failSend = false;
    const retried = await call("send", "第一版 https://news.example/item");
    expect(retried.status).toBe(200);
    expect(sent).toEqual(["第一版 （来源：news.example）"]);
    await expect(readReadyReport(DATE)).resolves.toBe("第一版 https://news.example/item");

    const again = await call("send", "第一版 https://news.example/item");
    const againBody = (await again.json()) as { status?: string };
    expect(again.status).toBe(200);
    expect(againBody.status).toBe("already_sent");
    expect(sent).toHaveLength(1);
    await expect(readReadyReport(DATE)).resolves.toBe("第一版 https://news.example/item");
  });

  it("does not resend when the QQ result is uncertain", async () => {
    let calls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("getAppAccessToken")) return Response.json({ access_token: "test-token", expires_in: 7200 });
      calls += 1;
      throw new Error("socket hang up");
    }) as typeof fetch;
    const first = await call("send", "待确认");
    expect(first.status).toBe(409);
    await expect(first.json()).resolves.toMatchObject({ saved: true, status: "uncertain" });
    const second = await call("send", "待确认");
    expect(second.status).toBe(409);
    await expect(second.json()).resolves.toMatchObject({ status: "uncertain" });
    expect(calls).toBe(1);
  });

  it("saves when the bound group is missing and reports that proactive send did not run", async () => {
    delete process.env.QQ_GROUP_OPENID;
    const response = await call("send", "只保存");
    const body = (await response.json()) as { status?: string; saved?: boolean };
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ saved: true, status: "unbound" });
    await expect(readReadyReport(DATE)).resolves.toBe("只保存");
  });

  it("returns a database error instead of claiming the report was saved", async () => {
    useQueryForTests(null);
    delete process.env.DATABASE_URL;
    const response = await call("save", "不能落盘");
    const body = (await response.json()) as { error?: string; ok?: boolean };
    expect(response.status).toBe(500);
    expect(body.error).toBe("日报数据库不可用");
    expect(body.ok).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("/tmp");
    expect(JSON.stringify(body)).not.toContain("postgres");
  });
});
