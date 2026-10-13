import { afterEach, describe, expect, it, vi } from "vitest";
import { buildDailyReport } from "@/lib/report";

const ENV_KEYS = [
  "QQ_APP_SECRET",
  "OPENAI_API_KEY",
  "OPENAI_MODEL",
  "DAILY_MESSAGE",
  "REPORT_SOURCE_URL",
  "REPORT_SOURCE_TOKEN",
] as const;

describe("buildDailyReport", () => {
  const originalFetch = globalThis.fetch;
  const saved = new Map<string, string | undefined>();

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    for (const key of ENV_KEYS) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    saved.clear();
  });

  function saveEnv(): void {
    for (const key of ENV_KEYS) saved.set(key, process.env[key]);
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_MODEL;
    delete process.env.DAILY_MESSAGE;
    delete process.env.REPORT_SOURCE_URL;
    delete process.env.REPORT_SOURCE_TOKEN;
    delete process.env.QQ_APP_SECRET;
  }

  it("reads JSON content from the report source and sends the bearer token only as a header", async () => {
    saveEnv();
    process.env.REPORT_SOURCE_URL = "https://example.com/report";
    process.env.REPORT_SOURCE_TOKEN = "source-token-value";
    let authorization = "";
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      authorization = new Headers(init?.headers).get("authorization") ?? "";
      return Response.json({ content: "外部日报" });
    }) as typeof fetch;

    await expect(buildDailyReport()).resolves.toBe("外部日报");
    expect(authorization).toBe("Bearer source-token-value");
  });

  it("falls back to DAILY_MESSAGE when OpenAI is not fully configured", async () => {
    saveEnv();
    process.env.OPENAI_API_KEY = "sk-test-key-value12";
    process.env.DAILY_MESSAGE = "fixed-daily";
    const logs: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    globalThis.fetch = (async () => {
      throw new Error("network should not be called");
    }) as typeof fetch;

    await expect(buildDailyReport()).resolves.toBe("fixed-daily");
    expect(logs.join("\n")).toContain("OPENAI_MODEL");
    expect(logs.join("\n")).not.toContain("sk-test-key-value12");
  });

  it("returns an error without secret values when every source is missing", async () => {
    saveEnv();
    process.env.QQ_APP_SECRET = "test-app-secret";
    let message = "";
    try {
      await buildDailyReport();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/DAILY_MESSAGE/);
    expect(message).not.toContain("test-app-secret");
  });
});
