import { afterEach, describe, expect, it, vi } from "vitest";
import { resetReplyClaims } from "@/lib/dedup";
import { POST } from "@/app/api/qq/webhook/route";
import { QA_FAILED, QA_UNCONFIGURED } from "@/lib/qa";
import { clearAccessTokenCache } from "@/lib/qq/token";
import { signUtf8, signValidation } from "@/lib/qq/signature";

const { createReply } = vi.hoisted(() => ({ createReply: vi.fn() }));

vi.mock("openai", () => ({
  default: class {
    responses = { create: createReply };
    constructor(_options: unknown) {}
  },
}));

const ENV_KEYS = ["QQ_APP_ID", "QQ_APP_SECRET", "QQ_API_BASE", "OPENAI_API_KEY", "OPENAI_MODEL"] as const;

describe("qq webhook", () => {
  const originalFetch = globalThis.fetch;
  const saved = new Map<string, string | undefined>();

  afterEach(() => {
    globalThis.fetch = originalFetch;
    clearAccessTokenCache();
    resetReplyClaims();
    createReply.mockReset();
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
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_MODEL;
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
      return Response.json({ message: "send failed", err_code: 40054007, trace_id: "trace-webhook" }, { status: 500 });
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

  async function postAt(content: string, id: string): Promise<{ status: number; bodies: Array<Record<string, unknown>>; logs: string[] }> {
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
      const fail = bodies.length === 1 && id === "event-send-fail";
      if (fail) {
        return Response.json({ message: "too long", err_code: 40054007, trace_id: "trace-fail" }, { status: 400 });
      }
      const duplicate = id === "event-deduped";
      if (duplicate) {
        return Response.json({ message: "deduped", err_code: 40054005, trace_id: "trace-dup" }, { status: 400 });
      }
      return Response.json({ id: "sent-1" }, { status: 200 });
    }) as typeof fetch;
    const raw = JSON.stringify({
      op: 0,
      t: "GROUP_AT_MESSAGE_CREATE",
      d: { id, group_openid: "gid-123", content },
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
    return { status: response.status, bodies, logs };
  }

  it("replies to an empty at-message, a normal question, and keeps the bind command", async () => {
    useSecret();
    const empty = await postAt("   ", "event-empty");
    expect(empty.status).toBe(200);
    expect(empty.bodies[0]?.content).toBe("我在，请告诉我你的问题。");
    expect(empty.logs.join("\n")).toContain('"branch":"reply_empty"');
    expect(empty.logs.join("\n")).toContain('"result":"sent"');

    const question = await postAt("什么是通货膨胀", "event-question");
    expect(question.bodies.at(-1)?.content).toBe(QA_UNCONFIGURED);
    expect(question.logs.join("\n")).toContain('"branch":"reply_qa"');
    expect(question.logs.join("\n")).toContain('"model":"unconfigured"');
    expect(question.logs.join("\n")).not.toContain("什么是通货膨胀");

    const command = await postAt("请绑定日报", "event-bind");
    expect(command.bodies.at(-1)?.content).toBe("机器人连接成功，已识别当前群聊。");
    expect(command.bodies.at(-1)?.msg_id).toBe("event-bind");
  });

  it("sends a short failure hint when the model call fails and does not mark a QQ error as sent", async () => {
    useSecret();
    process.env.OPENAI_API_KEY = "sk-test-key-value12";
    process.env.OPENAI_MODEL = "test-model";
    createReply.mockRejectedValue(new Error("timeout"));
    const logs: string[] = [];
    const errors: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("getAppAccessToken")) {
        return Response.json({ access_token: "test-token", expires_in: 7200 });
      }
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({ id: "sent-model-fail" }, { status: 200 });
    }) as typeof fetch;
    const raw = JSON.stringify({
      op: 0,
      t: "GROUP_AT_MESSAGE_CREATE",
      d: { id: "event-model-fail", group_openid: "gid-123", content: "解释一下市盈率" },
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
    expect(bodies[0]?.content).toBe(QA_FAILED);
    const combined = `${logs.join("\n")}\n${errors.join("\n")}`;
    expect(combined).toContain('"model":"failed"');
    expect(combined).toContain('"result":"sent"');
    expect(combined).not.toContain("sk-test-key-value12");
    expect(combined).not.toContain("解释一下市盈率");

    const failed = await postAt("再问一次", "event-send-fail");
    const failedLogs = failed.logs.join("\n");
    expect(failedLogs).toContain('"result":"failed"');
    expect(failedLogs).toContain('"err_code":40054007');
    expect(failedLogs).not.toContain('"result":"sent"');
  });

  it("does not send a second reply for the same message id", async () => {
    useSecret();
    const first = await postAt("什么是债券", "event-repeat");
    expect(first.bodies).toHaveLength(1);
    const second = await postAt("什么是债券", "event-repeat");
    expect(second.bodies).toHaveLength(0);
    expect(second.logs.join("\n")).toContain('"branch":"duplicate"');
    expect(second.logs.join("\n")).toContain('"result":"skipped"');

    const deduped = await postAt("什么是基金", "event-deduped");
    expect(deduped.logs.join("\n")).toContain('"result":"duplicate"');
    expect(deduped.logs.join("\n")).toContain('"err_code":40054005');
    expect(deduped.logs.join("\n")).not.toContain('"result":"sent"');
  });
});
