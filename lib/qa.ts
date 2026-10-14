import OpenAI from "openai";
import { optionalEnv } from "@/lib/env";
import { isRecord } from "@/lib/guard";
import { safeLogMessage } from "@/lib/redact";

const OPENAI_TIMEOUT_MS = 20_000;
export const QA_UNCONFIGURED = "已收到你的问题，智能问答尚未配置完成。";
export const QA_FAILED = "这次没能完成回答，请稍后再试。";
const LIVE_DISCLAIMER = "本次没有获取到实时资料，因此不能把回答当作最新新闻或行情。";
const LIVE_PATTERN = /新闻|行情|股价|大盘|汇率|财报|最新|涨跌|收盘|开盘/;

export type QaModelStatus = "unconfigured" | "ok" | "failed";

export type QaAnswer = {
  text: string;
  model: QaModelStatus;
  liveData: boolean;
};

function readOutputText(response: OpenAI.Responses.Response): string {
  const direct = response.output_text.trim();
  if (direct) return direct;
  const chunks: string[] = [];
  for (const item of response.output) {
    if (!isRecord(item) || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (isRecord(part) && typeof part.text === "string" && part.text.trim()) chunks.push(part.text);
    }
  }
  return chunks.join("\n").trim();
}

function hasLiveSources(response: OpenAI.Responses.Response): boolean {
  for (const item of response.output) {
    if (!isRecord(item) || item.type !== "web_search_call" || item.status !== "completed") continue;
    const action = item.action;
    if (!isRecord(action)) continue;
    if (Array.isArray(action.sources) && action.sources.length > 0) return true;
    if (typeof action.url === "string" && action.url.trim()) return true;
  }
  return false;
}

export function needsLiveInfo(question: string): boolean {
  return LIVE_PATTERN.test(question);
}

export async function answerQuestion(question: string): Promise<QaAnswer> {
  const apiKey = optionalEnv("OPENAI_API_KEY");
  const model = optionalEnv("OPENAI_MODEL");
  if (!apiKey || !model) {
    return { text: QA_UNCONFIGURED, model: "unconfigured", liveData: false };
  }

  const liveQuestion = needsLiveInfo(question);
  try {
    const client = new OpenAI({ apiKey, timeout: OPENAI_TIMEOUT_MS, maxRetries: 0 });
    const response = await client.responses.create({
      model,
      input: [
        "你是面向金融新手的中文助手。用中文回答问题。",
        "区分事实和推断。不要编造新闻、价格、财报数据或引用。不要输出 http 或 https 链接。",
        "只有本次请求实际拿到网页检索结果时，才可以说明使用了最新资料。没有检索结果时，禁止声称内容是最新新闻或最新行情。",
        `问题：${question}`,
      ].join("\n"),
      ...(liveQuestion ? { tools: [{ type: "web_search" as const }] } : {}),
    });
    const text = readOutputText(response);
    if (!text) throw new Error("OpenAI returned empty answer");
    const liveData = liveQuestion && hasLiveSources(response);
    return {
      text: liveQuestion && !liveData ? `${LIVE_DISCLAIMER}\n${text}` : text,
      model: "ok",
      liveData,
    };
  } catch (error) {
    console.error(JSON.stringify({ event: "qa_failed", model: "failed", message: safeLogMessage(error) }));
    return { text: QA_FAILED, model: "failed", liveData: false };
  }
}
