import { afterEach, describe, expect, it } from "vitest";
import { clearAccessTokenCache } from "@/lib/qq/token";
import { sendGroupText } from "@/lib/qq/send";

const ENV_KEYS = ["QQ_APP_ID", "QQ_APP_SECRET", "QQ_API_BASE"] as const;

type Captured = {
  url: string;
  body: Record<string, unknown>;
  authorization: string;
  appId: string | null;
};

describe("sendGroupText", () => {
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

  function useFakeCredentials(): void {
    for (const key of ENV_KEYS) saved.set(key, process.env[key]);
    process.env.QQ_APP_ID = "test-app-id";
    process.env.QQ_APP_SECRET = "test-app-secret";
    process.env.QQ_API_BASE = "https://sandbox.api.sgroup.qq.com";
  }

  it("sends proactive text without msg_id and retries a 401 only once", async () => {
    useFakeCredentials();
    const sends: Captured[] = [];
    let tokenCalls = 0;
    let messageCalls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("getAppAccessToken")) {
        tokenCalls += 1;
        return Response.json({ access_token: `test-token-${tokenCalls}`, expires_in: 7200 });
      }
      messageCalls += 1;
      const headers = new Headers(init?.headers);
      sends.push({
        url,
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        authorization: headers.get("authorization") ?? "",
        appId: headers.get("x-union-appid"),
      });
      if (messageCalls === 1) {
        return Response.json({ code: 11243, message: "token check failed", trace_id: "trace-1" }, { status: 401 });
      }
      return Response.json({ id: "msg-1" });
    }) as typeof fetch;

    const segments = await sendGroupText("group-1", "你好 https://example.com/path", { gapMs: 0 });
    expect(segments).toBe(1);
    expect(tokenCalls).toBe(2);
    expect(messageCalls).toBe(2);
    expect(sends[0]?.url).toContain("/v2/groups/group-1/messages");
    expect(sends[0]?.body.msg_type).toBe(0);
    expect(sends[0]?.body.msg_seq).toBe(1);
    expect(sends[0]?.body).not.toHaveProperty("msg_id");
    expect(String(sends[0]?.body.content)).not.toMatch(/https?:\/\//);
    expect(String(sends[0]?.body.content)).toContain("example.com");
    expect(sends[0]?.authorization.startsWith("QQBot ")).toBe(true);
    expect(sends[0]?.appId).toBe("test-app-id");
    expect(sends[1]?.body).not.toHaveProperty("msg_id");
  });

  it("does not retry forever when authentication keeps failing", async () => {
    useFakeCredentials();
    let messageCalls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("getAppAccessToken")) {
        return Response.json({ access_token: "test-token", expires_in: 7200 });
      }
      messageCalls += 1;
      return Response.json({ err_code: 11243, message: "unauthorized", trace_id: "trace-2" }, { status: 401 });
    }) as typeof fetch;

    await expect(sendGroupText("group-1", "你好", { gapMs: 0 })).rejects.toThrow(/HTTP 401/);
    expect(messageCalls).toBe(2);
  });

  it("passes msg_id only for a passive reply and increments msg_seq", async () => {
    useFakeCredentials();
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("getAppAccessToken")) {
        return Response.json({ access_token: "test-token", expires_in: 7200 });
      }
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({ id: "msg-2" });
    }) as typeof fetch;

    const content = `${"甲".repeat(1500)}\n${"乙".repeat(100)}`;
    const segments = await sendGroupText("group-1", content, { msgId: "msg-from-event", gapMs: 0 });
    expect(segments).toBeGreaterThan(1);
    expect(bodies.every((body) => body.msg_id === "msg-from-event")).toBe(true);
    expect(bodies.map((body) => body.msg_seq)).toEqual(bodies.map((_, index) => index + 1));
    expect(bodies.every((body) => String(body.content).trim().length > 0)).toBe(true);
  });

  it("refuses to send empty content", async () => {
    useFakeCredentials();
    globalThis.fetch = (async () => {
      throw new Error("network should not be called");
    }) as typeof fetch;
    await expect(sendGroupText("group-1", "   ")).rejects.toThrow(/empty/i);
  });
});
