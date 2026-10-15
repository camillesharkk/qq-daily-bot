import { optionalEnv } from "@/lib/env";
import { HOLDINGS, MAPPING_NOTE, holdingLines } from "@/lib/holdings";
import { runWebSearch } from "@/lib/qa";
import { safeLogMessage } from "@/lib/redact";

const REPORT_TIMEOUT_MS = 50_000;
const REPORT_MAX_TOKENS = 1800;
const PRIVATE_SENTENCE = /持仓金额|持仓数量|成本价|浮动盈亏|投入金额|1[,，]?000\s*澳元|每月[^。\n]{0,16}(1[,，]?000|一千)|可接受[^。\n]{0,12}20\s*%|账户跌幅\s*20/;
const SPCX_CLAIM = /SPCX[^。\n]{0,40}(就是|即为|确认为|等于)[^。\n]{0,30}(SpaceX|太空探索|未上市)/;

export function reportInstructions(date: string): string {
  return [
    "你是面向金融新手的中文财经老师。写一份学习日报，不要写成只有持仓的简报。",
    "用纯文本。不要使用 Markdown、星号或 http 链接。来源只写名称和日期。",
    "专业术语先写中文，再写英文或缩写。事实、分析和暂时不能确认的原因要分开。",
    "每条重要内容给一句短原文、中文翻译、通俗解释和推断依据。摘录要短。没有可靠公告就不要写财报日或分红日。",
    "已公告和预计日期要分开。财报发布日、除息日、登记日、支付日也不要混用。",
    "涨跌必须写市场、交易日期和数据时间。网页检索不是实时全市场行情。",
    "结构依次是：今日要闻、持仓相关、财报与分红、涨跌与数据时间、组合风险、长期学习。",
    "没有重要持仓新闻时写无重要新增，不要为了凑数重复。",
    "组合风险只做定性说明：NDQ 与 QQQ 跟踪同一类纳斯达克100指数，MSFT、NVDA、TSLA 与它们可能重叠，SMH 与 NVDA 同属半导体。没有注明日期的完整成分数据时，不要写精确风险比例。",
    "VAP 是澳洲房地产证券，XOM 是能源。美元和澳元汇率可能影响以澳元看的账户，不要假设产品有汇率对冲。",
    "读者打算多年持有，也会定期追加资金。不要因单日涨跌建议买卖，不要安排交易，正文不要出现追加金额、账户跌幅、持仓数量、成本或盈亏。",
    "关注列表：",
    holdingLines(),
    `今天的上海日期是 ${date}。全文用句号结束。`,
    `最后单独一行写：${MAPPING_NOTE}`,
  ].join("\n");
}

export function assessReport(text: string, validSources: number, hosts: readonly string[] = []): { ok: true; text: string } | { ok: false; reason: string } {
  const kept = text
    .split(/(?<=[。！？\n])/u)
    .map((part) => part.trim())
    .filter((part) => part && !PRIVATE_SENTENCE.test(part) && !SPCX_CLAIM.test(part))
    .join("");
  const body = kept.trim();
  if (!body) return { ok: false, reason: "empty" };
  if (body.includes("以上没有生成完整") || !/[。！？]$/.test(body)) return { ok: false, reason: "incomplete" };
  if (/^(我来|让我|我先|稍等|正在)/.test(body)) return { ok: false, reason: "preamble" };
  if (validSources < 1) return { ok: false, reason: "no_sources" };
  if (![...HOLDINGS.filter((item) => item.analyze).map((item) => item.symbol), "持仓"].some((word) => body.includes(word))) {
    return { ok: false, reason: "no_holdings" };
  }
  const sourceLine = hosts.length > 0 && !body.includes("来源") ? `\n检索来源：${hosts.slice(0, 6).join("、")}。` : "";
  const withNote = body.includes(MAPPING_NOTE) ? body : `${body}\n${MAPPING_NOTE}`;
  return { ok: true, text: `${withNote}${sourceLine}`.trim() };
}

export async function createDailyReport(date: string, requestId = "daily"): Promise<{ ok: true; text: string; sources: number } | { ok: false; reason: string }> {
  const apiKey = optionalEnv("DEEPSEEK_API_KEY");
  const model = optionalEnv("DEEPSEEK_MODEL");
  if (!apiKey || !model) return { ok: false, reason: "unconfigured" };
  try {
    const searched = await runWebSearch({
      apiKey,
      model,
      system: reportInstructions(date),
      user: `请写 ${date} 的财经学习日报。先检索今天可引用的新闻、财报和持仓相关公告，再写成完整正文。`,
      requestId,
      maxTokens: REPORT_MAX_TOKENS,
      timeoutMs: REPORT_TIMEOUT_MS,
      rounds: 2,
    });
    const assessed = assessReport(searched.text, searched.validSources, searched.hosts);
    if (!assessed.ok) return assessed;
    console.log(JSON.stringify({
      event: "daily_draft",
      request_id: requestId,
      chars: Array.from(assessed.text).length,
      sources: searched.validSources,
      complete: searched.complete ? 1 : 0,
    }));
    if (!searched.complete) return { ok: false, reason: "incomplete" };
    return { ok: true, text: assessed.text, sources: searched.validSources };
  } catch (error) {
    console.error(JSON.stringify({ event: "daily_draft_failed", request_id: requestId, message: safeLogMessage(error) }));
    return { ok: false, reason: "failed" };
  }
}
