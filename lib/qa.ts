import { optionalEnv } from "@/lib/env";
import { isRecord } from "@/lib/guard";
import { safeLogMessage } from "@/lib/redact";

const QA_TIMEOUT_MS = 20_000;
const QA_MAX_TOKENS = 800;
const QA_MAX_CHARS = 1200;
const REPORT_CONTEXT_CHARS = 3000;
const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";

export const QA_UNCONFIGURED = "已收到你的问题，智能问答尚未配置完成。";
export const QA_FAILED = "这次没能完成回答，请稍后再试。";
export const QA_BUSY = "提问有点频繁，请稍后再试。";
const LIVE_DISCLAIMER = "本次没有获取到实时资料，因此不能把回答当作最新新闻或行情。";
const LIVE_PATTERN = /新闻|行情|股价|大盘|汇率|财报|最新|涨跌|收盘|开盘/;

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

function systemPrompt(report?: string): string {
  const lines = [
    "你是面向金融新手的中文助手。先用通俗的话解释，再给出专业名称。",
    "区分事实和推断。不要编造新闻、价格、财报、基金代码、持仓盈亏、汇率对冲或组合收益。",
    "你没有联网检索。禁止声称已经查询实时新闻、股价或行情。不要输出 http 或 https 链接。",
  ];
  if (report?.trim()) {
    lines.push("下面是今天已经生成的日报，只能当作参考，不是实时行情。不要把日报里没有的数字说成事实。");
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
          { role: "system", content: systemPrompt(report) },
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
    return {
      text: liveQuestion ? `${LIVE_DISCLAIMER}\n${text}` : text,
      model: "ok",
      liveData: false,
    };
  } catch (error) {
    console.error(JSON.stringify({ event: "qa_failed", model: "failed", message: safeLogMessage(error) }));
    return { text: QA_FAILED, model: "failed", liveData: false };
  }
}
