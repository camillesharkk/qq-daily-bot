import { afterEach, describe, expect, it, vi } from "vitest";
import { answerQuestion } from "@/lib/qa";

const { createReply } = vi.hoisted(() => ({ createReply: vi.fn() }));

vi.mock("openai", () => ({
  default: class {
    responses = { create: createReply };
    constructor(_options: unknown) {}
  },
}));

const ENV_KEYS = ["OPENAI_API_KEY", "OPENAI_MODEL"] as const;

describe("answerQuestion", () => {
  const saved = new Map<string, string | undefined>();

  afterEach(() => {
    createReply.mockReset();
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
    process.env.OPENAI_API_KEY = "sk-test-key-value12";
    process.env.OPENAI_MODEL = "test-model";
  }

  it("says the assistant is not configured when the model env is missing", async () => {
    for (const key of ENV_KEYS) saved.set(key, process.env[key]);
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_MODEL;
    const answer = await answerQuestion("什么是利率");
    expect(answer).toEqual({
      text: "已收到你的问题，智能问答尚未配置完成。",
      model: "unconfigured",
      liveData: false,
    });
    expect(createReply).not.toHaveBeenCalled();
  });

  it("returns a short failure and does not log the api key when the model call fails", async () => {
    useModel();
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });
    createReply.mockRejectedValue(new Error("timeout"));
    const answer = await answerQuestion("解释市盈率");
    expect(answer.model).toBe("failed");
    expect(answer.text).toBe("这次没能完成回答，请稍后再试。");
    expect(errors.join("\n")).toContain('"model":"failed"');
    expect(errors.join("\n")).not.toContain("sk-test-key-value12");
    expect(errors.join("\n")).not.toContain("解释市盈率");
  });

  it("does not claim live market data unless web search returned sources", async () => {
    useModel();
    createReply.mockResolvedValueOnce({
      output_text: "今天市场波动较大。",
      output: [{ type: "web_search_call", status: "completed", action: { type: "search", sources: [] } }],
    });
    const withoutSources = await answerQuestion("今天的股市行情");
    expect(withoutSources.liveData).toBe(false);
    expect(withoutSources.text.startsWith("本次没有获取到实时资料")).toBe(true);
    expect(createReply).toHaveBeenCalledWith(expect.objectContaining({ tools: [{ type: "web_search" }] }));

    createReply.mockResolvedValueOnce({
      output_text: "来源名称：示例通讯社。",
      output: [
        {
          type: "web_search_call",
          status: "completed",
          action: { type: "search", sources: [{ type: "url", url: "https://example.com/news" }] },
        },
      ],
    });
    const withSources = await answerQuestion("最新财经新闻");
    expect(withSources.liveData).toBe(true);
    expect(withSources.text).toBe("来源名称：示例通讯社。");
    expect(withSources.text).not.toContain("https://");

    createReply.mockResolvedValueOnce({ output_text: "通胀是物价持续上涨。", output: [] });
    await answerQuestion("什么是通货膨胀");
    expect(createReply).toHaveBeenLastCalledWith(expect.not.objectContaining({ tools: expect.anything() }));
  });
});
