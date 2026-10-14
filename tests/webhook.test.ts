import { afterEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/qq/webhook/route";
import { clearAccessTokenCache } from "@/lib/qq/token";
import { signUtf8, signValidation } from "@/lib/qq/signature";

const ENV_KEYS = ["QQ_APP_ID", "QQ_APP_SECRET", "QQ_API_BASE"] as const;

describe("qq webhook", () => {
  const originalFetch = globalThis.fetch;
  const saved = new Map<string, string | undefined>();

  afterEach(() => {
    globalThis.fetch = originalFetch;
    clearAccessTokenCache();
    vi.restoreAllMocks();
    for (const key of ENV_KEYS) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    saved.clear();
  });

  function useSecret(secret = "route-test-secret"): void {
    for (const key of ENV_KEYS) saved.set(key, process.env[key]);
    process.env.QQ_APP_ID = "test-app-id";
    process.env.QQ_APP_SECRET = secret;
    process.env.QQ_API_BASE = "https://sandbox.api.sgroup.qq.com";
  }

  it("answers callback validation with the signed plain token", async () => {
    useSecret("DG5g3B4j9X2KOErG");
    const raw = JSON.stringify({
      op: 13,
      d: { plain_token: "Arq0D5A61EgUu4OxUvOp", event_ts: "1725442341" },
    });
    const response = await POST(new Request("https://example.com/api/qq/webhook", { method: "POST", body: raw }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      plain_token: "Arq0D5A61EgUu4OxUvOp",
      signature: signValidation("DG5g3B4j9X2KOErG", "1725442341", "Arq0D5A61EgUu4OxUvOp"),
    });
  });

  it("rejects a business event when signature headers are missing or the body changes", async () => {
    useSecret();
    const raw = '{ "op": 0, "t": "GROUP_ADD_ROBOT", "d": { "group_openid": "gid-123" } }';
    const missing = await POST(
      new Request("https://example.com/api/qq/webhook", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: raw,
      }),
    );
    expect(missing.status).toBe(401);

    const signature = signUtf8("route-test-secret", `1725442341${raw}`);
    const tampered = await POST(
      new Request("https://example.com/api/qq/webhook", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-signature-ed25519": signature,
          "x-signature-timestamp": "1725442341",
        },
        body: `${raw} `,
      }),
    );
    expect(tampered.status).toBe(401);
  });

  it("logs the event branch and does not call QQ unless the message asks for a reply", async () => {
    useSecret();
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    globalThis.fetch = (async () => {
      throw new Error("network should not be called");
    }) as typeof fetch;
    const raw = '{ "op": 0, "t": "GROUP_ADD_ROBOT", "d": { "group_openid": "gid-123" } }';
    const response = await POST(
      new Request("https://example.com/api/qq/webhook", {
        method: "POST",
        headers: {
          "x-signature-ed25519": signUtf8("route-test-secret", `1725442341${raw}`),
          "x-signature-timestamp": "1725442341",
        },
        body: raw,
      }),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ op: 12 });
    expect(logs).toContain("GROUP_OPENID_CAPTURED=gid-123");
    expect(logs.join("\n")).toContain('"type":"GROUP_ADD_ROBOT"');
    expect(logs.join("\n")).toContain('"branch":"ignore_event"');
    expect(logs.join("\n")).not.toContain("route-test-secret");

    const ignored = JSON.stringify({
      op: 0,
      t: "GROUP_AT_MESSAGE_CREATE",
      d: { id: "event-msg-ignored", group_openid: "gid-123", content: "今天随便聊聊" },
    });
    const ignoredResponse = await POST(
      new Request("https://example.com/api/qq/webhook", {
        method: "POST",
        headers: {
          "x-signature-ed25519": signUtf8("route-test-secret", `1725442341${ignored}`),
          "x-signature-timestamp": "1725442341",
        },
        body: ignored,
      }),
    );
    expect(ignoredResponse.status).toBe(200);
    expect(logs.join("\n")).toContain('"branch":"ignore_command"');
    expect(logs.join("\n")).not.toContain("今天随便聊聊");
  });

  it("replies with the event message id and still acks when sending fails", async () => {
    useSecret();
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("getAppAccessToken")) {
        return Response.json({ access_token: "test-token", expires_in: 7200 });
      }
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({ message: "send failed", err_code: 40054005, trace_id: "trace-webhook" }, { status: 500 });
    }) as typeof fetch;

    const raw = JSON.stringify({
      op: 0,
      t: "GROUP_AT_MESSAGE_CREATE",
      d: { id: "event-msg-1", group_openid: "gid-123", content: "请绑定日报" },
    });
    const response = await POST(
      new Request("https://example.com/api/qq/webhook", {
        method: "POST",
        headers: {
          "x-signature-ed25519": signUtf8("route-test-secret", `1725442341${raw}`),
          "x-signature-timestamp": "1725442341",
        },
        body: raw,
      }),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ op: 12 });
    expect(bodies[0]?.msg_id).toBe("event-msg-1");
    expect(bodies[0]?.content).toBe("机器人连接成功，已识别当前群聊。");
    expect(JSON.stringify(bodies)).not.toContain("route-test-secret");
  });

  it("replies to 你好 and waits for the QQ send result", async () => {
    useSecret();
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("getAppAccessToken")) {
        return Response.json({ access_token: "test-token", expires_in: 7200 });
      }
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({ id: "sent-1", err_code: 0 }, { status: 200 });
    }) as typeof fetch;

    const raw = JSON.stringify({
      op: 0,
      t: "GROUP_AT_MESSAGE_CREATE",
      d: { id: "event-msg-hello", group_openid: "gid-123", content: " 你好 " },
    });
    const response = await POST(
      new Request("https://example.com/api/qq/webhook", {
        method: "POST",
        headers: {
          "x-signature-ed25519": signUtf8("route-test-secret", `1725442341${raw}`),
          "x-signature-timestamp": "1725442341",
        },
        body: raw,
      }),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ op: 12 });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.msg_id).toBe("event-msg-hello");
    expect(bodies[0]?.msg_type).toBe(0);
    expect(bodies[0]?.content).toBe("你好，已收到你的消息，群消息接收和回复测试成功。");
    const combined = logs.join("\n");
    expect(combined).toContain('"type":"GROUP_AT_MESSAGE_CREATE"');
    expect(combined).toContain('"branch":"reply_hello"');
    expect(combined).toContain('"result":"sent"');
    expect(combined).toContain('"event":"qq_send_ok"');
    expect(combined).toContain('"status":200');
    expect(combined).not.toContain("test-token");
    expect(combined).not.toContain("route-test-secret");
  });
});
