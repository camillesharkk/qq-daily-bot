import { isRecord } from "@/lib/guard";
import { optionalEnv } from "@/lib/env";
import { readReadyReport, readSendState } from "@/lib/daily-store";
import { DailyStoreError } from "@/lib/db";
import { PUBLIC_ORIGIN, verifyAccessToken } from "@/lib/oauth";
import { publishDailyReport } from "@/lib/publish";
import { reportInstructions } from "@/lib/report";
import { safeLogMessage } from "@/lib/redact";
import { prepareQqMessages } from "@/lib/text";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const challenge = `Bearer resource_metadata="${PUBLIC_ORIGIN}/.well-known/oauth-protected-resource", scope="daily", error="invalid_token", error_description="Login required"`;

function unauthorized(): Response {
  return Response.json({ error: "unauthorized" }, { status: 401, headers: { "WWW-Authenticate": challenge } });
}

function rpc(id: unknown, result: unknown, status = 200): Response {
  return Response.json({ jsonrpc: "2.0", id, result }, { status });
}

function toolResult(id: unknown, text: string, isError = false): Response {
  return rpc(id, { content: [{ type: "text", text }], isError });
}

async function connectionStatus(): Promise<string> {
  const group = optionalEnv("QQ_GROUP_OPENID");
  let database = "ok";
  try {
    await readReadyReport("2026-10-14");
  } catch (error) {
    if (!(error instanceof DailyStoreError)) throw error;
    database = "unavailable";
  }
  return JSON.stringify({
    database,
    groupBound: Boolean(group),
    groupSuffix: group ? group.slice(-4) : null,
  });
}

async function readReport(date: string): Promise<string> {
  const content = await readReadyReport(date);
  const group = optionalEnv("QQ_GROUP_OPENID");
  const sendState = group ? await readSendState(date, group) : null;
  return JSON.stringify({
    date,
    content,
    sendState,
    segments: content ? prepareQqMessages(content).length : 0,
  });
}

export async function POST(request: Request): Promise<Response> {
  if (!verifyAccessToken(request.headers.get("authorization"))) return unauthorized();
  let payload: unknown;
  try {
    payload = JSON.parse(await request.text());
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  if (!isRecord(payload)) return Response.json({ error: "invalid json" }, { status: 400 });
  const id = payload.id ?? null;
  if (payload.method === "notifications/initialized") return new Response(null, { status: 202 });
  if (payload.method === "initialize") {
    return rpc(id, {
      protocolVersion: "2025-03-26",
      capabilities: { tools: {} },
      serverInfo: { name: "qq-daily-bot", version: "1.0.0" },
    });
  }
  if (payload.method === "tools/list") {
    return rpc(id, {
      tools: [
        {
          name: "connection_status",
          description: "查看数据库连接和是否已绑定目标群。不返回完整群标识。",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
          annotations: { readOnlyHint: true },
        },
        {
          name: "read_daily_report",
          description: "查看指定上海日期的日报原文和发送状态。",
          inputSchema: {
            type: "object",
            properties: { date: { type: "string", description: "Asia/Shanghai 日期，YYYY-MM-DD" } },
            required: ["date"],
            additionalProperties: false,
          },
          annotations: { readOnlyHint: true },
        },
        {
          name: "save_daily_report",
          description: `保存指定上海日期的日报原文，并立即按现有规则发到已绑定群。不调用 OpenAI 或 DeepSeek，不改写正文。同一天同一群已发送成功则不再发；失败可再试；结果不明确则不自动重发。生成正文前遵守：${reportInstructions("当天")}`,
          inputSchema: {
            type: "object",
            properties: {
              date: { type: "string", description: "Asia/Shanghai 日期，YYYY-MM-DD" },
              content: { type: "string", description: "日报原文" },
            },
            required: ["date", "content"],
            additionalProperties: false,
          },
        },
      ],
    });
  }
  if (payload.method !== "tools/call" || !isRecord(payload.params) || typeof payload.params.name !== "string") {
    return rpc(id, { code: -32601, message: "Method not found" });
  }
  const args = isRecord(payload.params.arguments) ? payload.params.arguments : {};
  try {
    if (payload.params.name === "connection_status") return toolResult(id, await connectionStatus());
    if (typeof args.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(args.date)) return toolResult(id, "日期无效", true);
    if (payload.params.name === "read_daily_report") return toolResult(id, await readReport(args.date));
    if (payload.params.name === "save_daily_report") {
      if (typeof args.content !== "string" || !args.content.trim()) return toolResult(id, "正文为空", true);
      const published = await publishDailyReport(args.date, args.content);
      return toolResult(id, JSON.stringify({
        saved: published.saved,
        status: published.status,
        errCode: published.errCode,
        segmentCount: published.segmentCount,
        message: published.message,
      }), !published.ok);
    }
    return toolResult(id, "未知工具", true);
  } catch (error) {
    console.error(JSON.stringify({ event: "mcp_daily", status: "failed", message: safeLogMessage(error) }));
    return toolResult(id, error instanceof DailyStoreError ? "日报数据库不可用" : "操作失败", true);
  }
}
