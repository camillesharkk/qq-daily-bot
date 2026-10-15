import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { shanghaiDate } from "@/lib/date";
import { HOLDINGS, MAPPING_NOTE } from "@/lib/holdings";
import { planReply } from "@/lib/reply";
import { reportInstructions } from "@/lib/report";
import { allowQuestion, resetQuestionLimits } from "@/lib/limit";

describe("daily commands and schedule", () => {
  it("matches 日报 before general questions and keeps the bind command", () => {
    expect(planReply("日报").branch).toBe("reply_daily");
    expect(planReply(" 日报。 ").branch).toBe("reply_daily");
    expect(planReply("绑定日报").branch).toBe("reply_bind");
    expect(planReply("测试").branch).toBe("reply_bind");
    const question = planReply("日报里的通胀是什么");
    expect(question).toEqual({ branch: "reply_qa", useReport: true });
    expect(planReply("什么是通货膨胀")).toEqual({ branch: "reply_qa", useReport: false });
  });

  it("generates before the 09:00 Beijing send window and lists checked tickers without amounts", () => {
    const config = JSON.parse(readFileSync("vercel.json", "utf8")) as { crons: Array<{ path: string; schedule: string }> };
    expect(config.crons).toEqual([
      { path: "/api/cron/generate", schedule: "0 23 * * *" },
      { path: "/api/cron/daily", schedule: "0 1 * * *" },
    ]);
    expect(shanghaiDate(new Date("2026-10-13T16:00:00Z"))).toBe("2026-10-14");
    expect(shanghaiDate(new Date("2026-10-13T15:59:00Z"))).toBe("2026-10-13");
    expect(planReply("今日日报").branch).toBe("reply_daily");
    expect(HOLDINGS.filter((item) => item.analyze).map((item) => item.symbol)).toEqual(["NDQ", "VAP", "QQQ", "MSFT", "NVDA", "TSLA", "SMH", "XOM"]);
    expect(HOLDINGS.find((item) => item.symbol === "SPCX")?.analyze).toBe(false);
    const instructions = reportInstructions("2026-10-16");
    expect(instructions).toContain("QQQ");
    expect(instructions).toContain("NVDA");
    expect(instructions).toContain(MAPPING_NOTE);
    expect(instructions).not.toContain("1000");
    expect(instructions).not.toContain("1,000");
    expect(instructions).not.toContain("20%");
    expect(JSON.stringify(HOLDINGS)).not.toContain("1000");
  });

  it("limits repeated questions for one group", () => {
    resetQuestionLimits();
    const now = 1_000_000;
    for (let index = 0; index < 5; index += 1) expect(allowQuestion("gid", now + index)).toBe(true);
    expect(allowQuestion("gid", now + 6)).toBe(false);
    expect(allowQuestion("other", now + 6)).toBe(true);
    expect(allowQuestion("gid", now + 60_000)).toBe(true);
  });
});
