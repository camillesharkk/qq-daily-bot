import OpenAI from "openai";
import { shanghaiDate } from "@/lib/date";
import { optionalEnv } from "@/lib/env";
import { isRecord } from "@/lib/guard";
import { safeLogMessage } from "@/lib/redact";

const SOURCE_TIMEOUT_MS = 15_000;
const OPENAI_TIMEOUT_MS = 45_000;

const REPORT_PROMPT = [
  "你是一名面向金融新手的中文财经老师。生成今天的金融学习日报，日期按 Asia/Shanghai。覆盖重要国内外财经新闻、上市公司财报或公司动态、宏观经济、主要市场变化、重要商业人物或政策制定者讲话。每条包括：发生了什么、中文解释、相关专业名词解释、为什么重要、可能的影响、推断链条、需要继续观察什么。明确区分事实与推断，不编造数据。尽可能给出信息来源名称和原始标题，但QQ群正文中不要放未经报备的URL。内容适合金融初学者阅读。",
  "明确区分事实和推断。不得编造新闻、价格、财报数据或引用。输出中文。专业术语第一次出现时使用“中文名称（English term / abbreviation）”格式。",
].join("\n");

function parseReportPayload(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("Report source returned empty content");
  if (trimmed.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isRecord(parsed) && typeof parsed.content === "string" && parsed.content.trim()) {
        return parsed.content.trim();
      }
      if (parsed !== null && typeof parsed === "object") {
        throw new Error("Report source JSON missing content");
      }
    } catch (error) {
      if (error instanceof SyntaxError) return trimmed;
      throw error;
    }
  }
  return trimmed;
}

async function fetchExternalReport(url: string): Promise<string> {
  const headers = new Headers({ Accept: "application/json, text/plain;q=0.9,*/*;q=0.8" });
  const token = optionalEnv("REPORT_SOURCE_TOKEN");
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(url, {
    method: "GET",
    cache: "no-store",
    headers,
    redirect: "follow",
    signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Report source request failed: HTTP ${response.status}`);
  }
  return parseReportPayload(await response.text());
}

function readOutputText(response: OpenAI.Responses.Response): string {
  const direct = response.output_text.trim();
  if (direct) return direct;
  const chunks: string[] = [];
  for (const item of response.output) {
    if (!isRecord(item) || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (isRecord(part) && typeof part.text === "string" && part.text.trim()) {
        chunks.push(part.text);
      }
    }
  }
  return chunks.join("\n").trim();
}

async function generateOpenAIReport(): Promise<string> {
  const apiKey = optionalEnv("OPENAI_API_KEY");
  const model = optionalEnv("OPENAI_MODEL");
  if (!apiKey) throw new Error("OPENAI_API_KEY is not configured");
  if (!model) throw new Error("OPENAI_MODEL is required when OPENAI_API_KEY is set");

  const client = new OpenAI({ apiKey, timeout: OPENAI_TIMEOUT_MS, maxRetries: 0 });
  const response = await client.responses.create({
    model,
    input: `${REPORT_PROMPT}\n\n今天（Asia/Shanghai）是 ${shanghaiDate()}。`,
    tools: [{ type: "web_search" }],
  });
  const text = readOutputText(response);
  if (!text) throw new Error("OpenAI returned empty report");
  return text;
}

export async function buildDailyReport(): Promise<string> {
  const sourceUrl = optionalEnv("REPORT_SOURCE_URL");
  if (sourceUrl) {
    try {
      const content = await fetchExternalReport(sourceUrl);
      if (content.trim()) return content;
    } catch (error) {
      console.error(JSON.stringify({ event: "report_source_failed", message: safeLogMessage(error) }));
    }
  }

  if (optionalEnv("OPENAI_API_KEY")) {
    try {
      const content = await generateOpenAIReport();
      if (content.trim()) return content;
    } catch (error) {
      console.error(JSON.stringify({ event: "openai_report_failed", message: safeLogMessage(error) }));
    }
  }

  const daily = optionalEnv("DAILY_MESSAGE");
  if (daily) return daily;

  throw new Error(
    "No daily report content. Set REPORT_SOURCE_URL, OPENAI_API_KEY with OPENAI_MODEL, or DAILY_MESSAGE.",
  );
}
