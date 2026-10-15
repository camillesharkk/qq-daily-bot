import { optionalEnv } from "@/lib/env";
import { isRecord } from "@/lib/guard";
import { safeLogMessage } from "@/lib/redact";

const QA_TIMEOUT_MS = 20_000;
const SEARCH_TIMEOUT_MS = 45_000;
const QA_MAX_TOKENS = 800;
const QA_MAX_CHARS = 1200;
const REPORT_CONTEXT_CHARS = 3000;
const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";
const DEEPSEEK_SEARCH_URL = "https://api.deepseek.com/anthropic/v1/messages";

export const QA_UNCONFIGURED = "已收到你的问题，智能问答尚未配置完成。";
export const QA_FAILED = "这次没能完成回答，请稍后再试。";
export const QA_BUSY = "提问有点频繁，请稍后再试。";
const LIVE_DISCLAIMER = "本次没有获取到实时资料，因此不能把回答当作最新新闻或行情。";
const LIVE_PATTERN = /新闻|行情|股价|大盘|汇率|财报|最新|涨跌|收盘|开盘|跌|涨|指数|板块|成交/;

export type QaModelStatus = "unconfigured" | "ok" | "failed";

export type QaAnswer = {
  text: string;
  model: QaModelStatus;
  liveData: boolean;
};

function clip(text: string, max: number): string {
  const units = Array.from(text);
  return units.length <= max ? text : units.slice(0, max).join("");
}

function systemPrompt(report: string | undefined, search: boolean): string {
  const lines = [
    "你是面向金融新手的中文助手。先用通俗的话解释，再给出专业名称。",
    "区分事实和推断。不要编造新闻、价格、财报、基金代码、持仓盈亏、汇率对冲或组合收益。",
    "用纯文本回答，不要使用 Markdown 或加粗符号，不要输出 http 或 https 链接。",
  ];
  if (search) {
    lines.push("这个问题需要最新资料。使用联网检索。回答行情、涨跌或排名时必须写明市场、交易日期、数据时间和来源名称。网页检索不是实时全市场排名，不能把搜索结果直接说成此刻谁跌得最狠。缺少这些信息时直接说明不足以排名，不要编造。没有检索到就直接说这次没查到。");
  } else {
    lines.push("这是概念或已有材料的解释。不要把记忆中的数字说成今日行情或新闻。");
  }
  if (report?.trim()) {
    lines.push("下面是今天已经保存的日报，只能当作参考，不是新的检索结果。不要把日报里没有的数字说成事实。");
    lines.push(clip(report.trim(), REPORT_CONTEXT_CHARS));
  } else {
    lines.push("今天没有可引用的日报。不要编造日报内容。");
  }
  return lines.join("\n");
}

function readChatText(parsed: unknown): string {
  if (!isRecord(parsed) || !Array.isArray(parsed.choices)) return "";
  const first = parsed.choices[0];
  if (!isRecord(first) || !isRecord(first.message)) return "";
  return typeof first.message.content === "string" ? first.message.content.trim() : "";
}

type SearchShape = {
  text: string;
  executed: boolean;
  validSources: number;
  errors: number;
  emptyResults: number;
  hosts: string[];
};

function sourceHost(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./i, "") || null;
  } catch {
    return null;
  }
}

function isValidResult(item: unknown): item is { url: string } {
  return isRecord(item) && item.type === "web_search_result" && typeof item.url === "string" && item.url.trim().length > 0;
}

function isSearchError(item: unknown): boolean {
  return isRecord(item) && item.type === "web_search_tool_result_error";
}

function readInnerResults(content: unknown, shape: SearchShape): void {
  if (Array.isArray(content)) {
    if (content.length === 0) {
      shape.emptyResults += 1;
      return;
    }
    let valid = 0;
    for (const item of content) {
      if (isValidResult(item)) {
        valid += 1;
        const host = sourceHost(item.url.trim());
        if (host && !shape.hosts.includes(host)) shape.hosts.push(host);
      } else if (isSearchError(item)) {
        shape.errors += 1;
      }
    }
    shape.validSources += valid;
    if (valid === 0 && !content.some((item) => isSearchError(item))) shape.emptyResults += 1;
    return;
  }
  if (isSearchError(content)) {
    shape.errors += 1;
    return;
  }
  shape.emptyResults += 1;
}

export function readSearchAnswer(parsed: unknown): SearchShape {
  const shape: SearchShape = { text: "", executed: false, validSources: 0, errors: 0, emptyResults: 0, hosts: [] };
  if (!isRecord(parsed)) return shape;
  if (typeof parsed.content === "string") {
    shape.text = parsed.content.trim();
    return shape;
  }
  if (!Array.isArray(parsed.content)) return shape;
  const texts: string[] = [];
  for (const block of parsed.content) {
    if (!isRecord(block)) continue;
    if (block.type === "server_tool_use" && block.name === "web_search") shape.executed = true;
    if (block.type === "text" && typeof block.text === "string" && block.text.trim()) texts.push(block.text.trim());
    if (block.type !== "web_search_tool_result") continue;
    shape.executed = true;
    readInnerResults(block.content, shape);
  }
  shape.text = texts.join("\n").trim();
  return shape;
}

export function needsLiveInfo(question: string): boolean {
  return LIVE_PATTERN.test(question);
}

export async function answerQuestion(question: string, report?: string): Promise<QaAnswer> {
  const apiKey = optionalEnv("DEEPSEEK_API_KEY");
  const model = optionalEnv("DEEPSEEK_MODEL");
  if (!apiKey || !model) {
    return { text: QA_UNCONFIGURED, model: "unconfigured", liveData: false };
  }

  const liveQuestion = needsLiveInfo(question);
  try {
    if (liveQuestion) return await answerWithSearch(apiKey, model, question, report);
    const response = await fetch(DEEPSEEK_URL, {
      method: "POST",
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt(report, false) },
          { role: "user", content: question },
        ],
        max_tokens: QA_MAX_TOKENS,
        stream: false,
      }),
      signal: AbortSignal.timeout(QA_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`DeepSeek request failed: HTTP ${response.status}`);
    const text = clip(readChatText(await response.json()), QA_MAX_CHARS);
    if (!text) throw new Error("DeepSeek returned empty answer");
    return { text, model: "ok", liveData: false };
  } catch (error) {
    console.error(JSON.stringify({ event: "qa_failed", model: "failed", message: safeLogMessage(error) }));
    return { text: QA_FAILED, model: "failed", liveData: false };
  }
}

async function answerWithSearch(apiKey: string, model: string, question: string, report?: string): Promise<QaAnswer> {
  const response = await fetch(DEEPSEEK_SEARCH_URL, {
    method: "POST",
    cache: "no-store",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: QA_MAX_TOKENS,
      system: systemPrompt(report, true),
      messages: [{ role: "user", content: question }],
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }],
    }),
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`DeepSeek search failed: HTTP ${response.status}`);
  const answer = readSearchAnswer(await response.json());
  const text = clip(answer.text, QA_MAX_CHARS);
  if (!text) throw new Error("DeepSeek search returned empty answer");
  console.log(JSON.stringify({
    event: "qa_search",
    executed: answer.executed ? 1 : 0,
    valid_sources: answer.validSources,
    errors: answer.errors,
    empty_results: answer.emptyResults,
  }));
  return {
    text: answer.validSources > 0 ? text : `${LIVE_DISCLAIMER}\n${text}`,
    model: "ok",
    liveData: answer.validSources > 0,
  };
}
