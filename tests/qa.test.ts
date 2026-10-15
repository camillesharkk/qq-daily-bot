import { afterEach, describe, expect, it, vi } from "vitest";
import { answerQuestion, needsLiveInfo, readSearchAnswer } from "@/lib/qa";

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

  it("searches for live market questions and keeps concepts on the chat endpoint", async () => {
    useModel();
    const calls: Array<{ url: string; body: string }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = String(init?.body);
      calls.push({ url, body });
      if (url.includes("/anthropic/v1/messages")) {
        const searched = body.includes("今天的股市行情") || body.includes("今天谁跌得最狠");
        return Response.json({
          content: [
            { type: "server_tool_use", name: "web_search", input: { query: "股市" } },
            searched
              ? { type: "web_search_tool_result", content: [{ type: "web_search_result", url: "https://news.example.com/a", title: "收盘" }] }
              : { type: "web_search_tool_result", content: { type: "web_search_tool_result_error", error_code: "unavailable" } },
            { type: "text", text: searched ? "今天主要指数上涨。来源：news.example.com" : "这次没有查到公开行情。" },
          ],
        });
      }
      return Response.json({
        choices: [{ message: { content: "物价持续上涨可以理解为钱更不值钱。" } }],
      });
    }) as typeof fetch;

    expect(needsLiveInfo("今天谁跌得最狠")).toBe(true);
    expect(needsLiveInfo("什么是利率")).toBe(false);
    const ranked = await answerQuestion("今天谁跌得最狠");
    expect(ranked.liveData).toBe(true);
    expect(calls[0]?.url).toContain("/anthropic/v1/messages");
    expect(calls[0]?.body).toContain("必须写明市场、交易日期、数据时间和来源名称");
    expect(calls[0]?.body).toContain("不是实时全市场排名");

    const live = await answerQuestion("今天的股市行情");
    expect(live.liveData).toBe(true);
    expect(live.text).toBe("今天主要指数上涨。来源：news.example.com");
    expect(live.text.startsWith("本次没有获取到实时资料")).toBe(false);
    expect(calls[1]?.url).toContain("/anthropic/v1/messages");
    expect(calls[1]?.body).toContain("deepseek-flash");
    expect(calls[1]?.body).toContain("web_search_20250305");
    expect(calls[1]?.body).not.toContain("你没有联网检索");
    expect(calls[1]?.body).not.toContain("sk-deepseek-test-value");

    const missed = await answerQuestion("最新汇率");
    expect(missed.liveData).toBe(false);
    expect(missed.text.startsWith("本次没有获取到实时资料")).toBe(true);

    const follow = await answerQuestion("日报里提到了什么", "今日学习：利率是借钱的价格。");
    expect(follow.liveData).toBe(false);
    expect(follow.text).toContain("钱更不值钱");
    expect(calls[3]?.url).toContain("/chat/completions");
    expect(calls[3]?.body).toContain("今日学习：利率是借钱的价格。");
    expect(calls[3]?.body).not.toContain("web_search");
    expect(calls[3]?.body).not.toContain("你没有联网检索");
  });

  it("counts only inner search results and keeps errors or empty wrappers unused", () => {
    const valid = readSearchAnswer({
      content: [
        { type: "web_search_tool_result", content: [{ type: "web_search_result", url: "https://news.example.com/a" }] },
      ],
    });
    expect(valid.validSources).toBe(1);
    expect(valid.hosts).toEqual(["news.example.com"]);

    const error = readSearchAnswer({
      content: [
        { type: "web_search_tool_result", content: { type: "web_search_tool_result_error", error_code: "unavailable" } },
      ],
    });
    expect(error.executed).toBe(true);
    expect(error.validSources).toBe(0);
    expect(error.errors).toBe(1);

    const empty = readSearchAnswer({
      content: [{ type: "web_search_tool_result", content: [] }],
    });
    expect(empty.validSources).toBe(0);
    expect(empty.emptyResults).toBe(1);

    const blankUrl = readSearchAnswer({
      content: [{ type: "web_search_tool_result", content: [{ type: "web_search_result", url: " " }] }],
    });
    expect(blankUrl.validSources).toBe(0);
    expect(blankUrl.emptyResults).toBe(1);

    const mixed = readSearchAnswer({
      content: [
        { type: "server_tool_use", name: "web_search" },
        { type: "web_search_tool_result", content: [{ type: "web_search_result", url: "https://news.example.com/a" }] },
        { type: "web_search_tool_result", content: [{ type: "web_search_tool_result_error", error_code: "max_uses_exceeded" }] },
      ],
    });
    expect(mixed.executed).toBe(true);
    expect(mixed.validSources).toBe(1);
    expect(mixed.errors).toBe(1);
    expect(mixed.emptyResults).toBe(0);
  });
});
