import { afterEach, describe, expect, it, vi } from "vitest";
import { answerQuestion } from "@/lib/qa";

const ENV_KEYS = ["DEEPSEEK_API_KEY", "DEEPSEEK_MODEL"] as const;

describe("answerQuestion", () => {
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

  function useModel(): void {
    for (const key of ENV_KEYS) saved.set(key, process.env[key]);
    process.env.DEEPSEEK_API_KEY = "sk-deepseek-test-value";
    process.env.DEEPSEEK_MODEL = "deepseek-flash";
  }

  it("says the assistant is not configured when the model env is missing", async () => {
    for (const key of ENV_KEYS) saved.set(key, process.env[key]);
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.DEEPSEEK_MODEL;
    const answer = await answerQuestion("什么是利率");
    expect(answer).toEqual({
      text: "已收到你的问题，智能问答尚未配置完成。",
      model: "unconfigured",
      liveData: false,
    });
  });

  it("returns a short failure and does not log the api key when the model call fails", async () => {
    useModel();
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });
    globalThis.fetch = (async () => {
      throw new Error("timeout");
    }) as typeof fetch;
    const answer = await answerQuestion("解释市盈率");
    expect(answer.model).toBe("failed");
    expect(answer.text).toBe("这次没能完成回答，请稍后再试。");
    expect(errors.join("\n")).toContain('"model":"failed"');
    expect(errors.join("\n")).not.toContain("sk-deepseek-test-value");
    expect(errors.join("\n")).not.toContain("解释市盈率");
  });

  it("does not claim live market data and can include today's report as context", async () => {
    useModel();
    const bodies: string[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return Response.json({
        choices: [{ message: { content: "物价持续上涨可以理解为钱更不值钱。" } }],
      });
    }) as typeof fetch;

    const live = await answerQuestion("今天的股市行情");
    expect(live.liveData).toBe(false);
    expect(live.text.startsWith("本次没有获取到实时资料")).toBe(true);
    expect(live.text).not.toContain("https://");
    expect(bodies[0]).toContain("deepseek-flash");
    expect(bodies[0]).not.toContain("web_search");

    const follow = await answerQuestion("日报里提到了什么", "今日学习：利率是借钱的价格。");
    expect(follow.liveData).toBe(false);
    expect(follow.text).toContain("钱更不值钱");
    expect(bodies[1]).toContain("今日学习：利率是借钱的价格。");
    expect(bodies[1]).not.toContain("sk-deepseek-test-value");
  });
});
