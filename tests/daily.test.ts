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

  it("keeps the server cron paused and unverified holding labels", () => {
    const config = JSON.parse(readFileSync("vercel.json", "utf8")) as { crons: unknown[] };
    expect(config.crons).toEqual([]);
    expect(shanghaiDate(new Date("2026-10-13T16:00:00Z"))).toBe("2026-10-14");
    expect(shanghaiDate(new Date("2026-10-13T15:59:00Z"))).toBe("2026-10-13");
    expect(HOLDINGS.reduce((sum, item) => sum + item.weightPercent, 0)).toBe(100);
    expect(HOLDINGS.every((item) => item.status === "未核实")).toBe(true);
    const instructions = reportInstructions("2026-10-14");
    expect(instructions).toContain("纳斯达克100指数");
    expect(instructions).toContain("暂按纳斯达克综合指数");
    expect(instructions).toContain("澳元兑美元");
    expect(instructions).toContain("无重要新增");
    expect(instructions).toContain("检索失败");
    expect(instructions).toContain(MAPPING_NOTE);
    expect(instructions).not.toContain("QQQ");
    expect(instructions).not.toContain("NVDA");
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
