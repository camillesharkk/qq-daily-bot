import { afterEach, describe, expect, it } from "vitest";
import { GET as generate } from "@/app/api/cron/generate/route";
import { inSendWindow, shanghaiDate } from "@/lib/date";
import { readDailyStatus, readReadyReport } from "@/lib/daily-store";
import { useQueryForTests } from "@/lib/db";
import { MAPPING_NOTE } from "@/lib/holdings";
import { assessReport } from "@/lib/report";
import { createMemoryQuery } from "./memory-db";

describe("daily report acceptance", () => {
  const originalFetch = globalThis.fetch;
  const saved = new Map<string, string | undefined>();

  afterEach(() => {
    globalThis.fetch = originalFetch;
    useQueryForTests(null);
    for (const key of ["CRON_SECRET", "DEEPSEEK_API_KEY", "DEEPSEEK_MODEL"]) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    saved.clear();
  });

  it("keeps the send window inside the Beijing 09:00 hour", () => {
    expect(inSendWindow(new Date("2026-10-16T01:00:00Z"))).toBe(true);
    expect(inSendWindow(new Date("2026-10-16T01:59:00Z"))).toBe(true);
    expect(inSendWindow(new Date("2026-10-15T23:30:00Z"))).toBe(false);
    expect(inSendWindow(new Date("2026-10-15T16:18:00Z"))).toBe(false);
  });

  it("rejects private amounts, an unfinished draft, and an unverified SPCX claim", () => {
    const hidden = assessReport("持仓金额是1000澳元。NDQ 无重要新增。", 1, ["news.example.com"]);
    expect(hidden.ok).toBe(true);
    if (hidden.ok) {
      expect(hidden.text).not.toContain("1000");
      expect(hidden.text).toContain("NDQ");
      expect(hidden.text).toContain(MAPPING_NOTE);
    }
    expect(assessReport("我来联网查一下。", 1).ok).toBe(false);
    expect(assessReport("市盈率高，", 1).ok).toBe(false);
    expect(assessReport("SPCX就是SpaceX股票。NDQ 无重要新增。", 0).ok).toBe(false);
  });

  it("does not store a preamble as the ready report and does not call the model again after two failures", async () => {
    for (const key of ["CRON_SECRET", "DEEPSEEK_API_KEY", "DEEPSEEK_MODEL"]) saved.set(key, process.env[key]);
    useQueryForTests(createMemoryQuery());
    process.env.CRON_SECRET = "test-cron-secret";
    process.env.DEEPSEEK_API_KEY = "sk-test-value";
    process.env.DEEPSEEK_MODEL = "deepseek-flash";
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return Response.json({
        stop_reason: "end_turn",
        content: [{ type: "text", text: "我来联网查一下最新情况。" }],
      });
    }) as typeof fetch;

    const date = shanghaiDate();
    const first = await generate(new Request("https://example.com/api/cron/generate", { headers: { authorization: "Bearer test-cron-secret" } }));
    const firstBody = await first.json();
    expect(firstBody).toMatchObject({ ok: false, status: "failed" });
    expect(JSON.stringify(firstBody)).not.toContain("sk-test-value");
    expect(await readDailyStatus(date)).toBe("failed");
    expect(await readReadyReport(date)).toBeNull();

    await generate(new Request("https://example.com/api/cron/generate", { headers: { authorization: "Bearer test-cron-secret" } }));
    const third = await generate(new Request("https://example.com/api/cron/generate", { headers: { authorization: "Bearer test-cron-secret" } }));
    expect(await third.json()).toMatchObject({ status: "failed" });
    expect(calls).toBe(2);
  });

  it("saves a complete sourced draft and does not generate it again", async () => {
    for (const key of ["CRON_SECRET", "DEEPSEEK_API_KEY", "DEEPSEEK_MODEL"]) saved.set(key, process.env[key]);
    useQueryForTests(createMemoryQuery());
    process.env.CRON_SECRET = "test-cron-secret";
    process.env.DEEPSEEK_API_KEY = "sk-test-value";
    process.env.DEEPSEEK_MODEL = "deepseek-flash";
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return Response.json({
        stop_reason: "end_turn",
        content: [
          { type: "server_tool_use", name: "web_search" },
          { type: "web_search_tool_result", content: [{ type: "web_search_result", url: "https://news.example.com/a", title: "收盘" }] },
          { type: "text", text: "今日要闻比较平静。持仓相关：NDQ 无重要新增。以上是事实，推断单独说明。" },
        ],
      });
    }) as typeof fetch;

    const date = shanghaiDate();
    const created = await generate(new Request("https://example.com/api/cron/generate", { headers: { authorization: "Bearer test-cron-secret" } }));
    expect(await created.json()).toMatchObject({ ok: true, status: "created" });
    const savedReport = await readReadyReport(date);
    expect(savedReport).toContain("NDQ");
    expect(savedReport).toContain(MAPPING_NOTE);
    expect(savedReport).not.toContain("1000");
    const again = await generate(new Request("https://example.com/api/cron/generate", { headers: { authorization: "Bearer test-cron-secret" } }));
    expect(await again.json()).toMatchObject({ status: "ready" });
    expect(calls).toBe(1);
  });
});
