import { isRecord } from "@/lib/guard";
import { optionalEnv } from "@/lib/env";
import { readReadyReport, readSendState } from "@/lib/daily-store";
import { DailyStoreError } from "@/lib/db";
import { MCP_RESOURCE, PUBLIC_ORIGIN, verifyAccessToken } from "@/lib/oauth";
import { publishDailyReport } from "@/lib/publish";
import { reportInstructions } from "@/lib/report";
import { safeLogMessage } from "@/lib/redact";
import { prepareQqMessages } from "@/lib/text";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07"];
const DISCOVERY_METHODS = new Set([
  "initialize",
  "notifications/initialized",
  "ping",
  "tools/list",
  "resources/list",
  "prompts/list",
]);

const challenge = `Bearer resource_metadata="${PUBLIC_ORIGIN}/.well-known/oauth-protected-resource/api/mcp", scope="daily", error="invalid_token", error_description="Login required"`;

const SAVE_DESCRIPTION = "保存指定上海日期的日报原文，并立即向已绑定的 QQ 群主动发送该正文。这是写入操作：保存成功后会调用 QQ 发群，不是只读。不调用 OpenAI 或 DeepSeek，不改写正文。同一天同一群已发送成功则不再发；发送失败可再次调用重试；发送结果不明确时不会自动重发。";

function logMcp(method: string, auth: "missing" | "invalid" | "valid", status: number): void {
  console.log(JSON.stringify({ event: "mcp_http", method, auth, status }));
}

function unauthorized(): Response {
  return Response.json({ error: "unauthorized" }, { status: 401, headers: { "WWW-Authenticate": challenge } });
}

function wantsEventStream(request: Request): boolean {
  return (request.headers.get("accept") ?? "").includes("text/event-stream");
}

function respond(request: Request, status: number, body: unknown): Response {
  const json = JSON.stringify(body);
  if (wantsEventStream(request)) {
    return new Response(`event: message\ndata: ${json}\n\n`, {
      status,
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
    });
  }
  return new Response(json, { status, headers: { "content-type": "application/json" } });
}

function rpc(id: unknown, result: unknown): unknown {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: unknown, code: number, message: string): unknown {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function originAllowed(origin: string | null): boolean {
  if (!origin || origin === "null") return true;
  if (origin === PUBLIC_ORIGIN || origin === "https://chatgpt.com" || origin === "https://chat.openai.com") return true;
  try {
    const url = new URL(origin);
    return (url.hostname === "localhost" || url.hostname === "127.0.0.1") && url.protocol === "http:";
  } catch {
    return false;
  }
}

function protocolVersion(params: unknown): string {
  const requested = isRecord(params) && typeof params.protocolVersion === "string" ? params.protocolVersion : "";
  return PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0];
}

function tools(): unknown[] {
  return [
    {
      name: "connection_status",
      description: "查看数据库连接和是否已绑定目标群。不返回完整群标识，不发送消息。",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "read_daily_report",
      description: "查看指定上海日期的日报原文和发送状态。不发送消息。",
      inputSchema: {
        type: "object",
        properties: { date: { type: "string", description: "Asia/Shanghai 日期，YYYY-MM-DD" } },
        required: ["date"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "save_daily_report",
      description: SAVE_DESCRIPTION,
      inputSchema: {
        type: "object",
        properties: {
          date: { type: "string", description: "Asia/Shanghai 日期，YYYY-MM-DD" },
          content: { type: "string", description: "日报原文。保存后会按原文发到 QQ 群。" },
        },
        required: ["date", "content"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
  ];
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

export function GET(): Response {
  return new Response(null, { status: 405, headers: { allow: "POST" } });
}

export function DELETE(): Response {
  return new Response(null, { status: 405, headers: { allow: "POST" } });
}

export async function POST(request: Request): Promise<Response> {
  if (!originAllowed(request.headers.get("origin"))) {
    logMcp("rejected", "missing", 403);
    return respond(request, 403, rpcError(null, -32003, "origin not allowed"));
  }
  const header = request.headers.get("authorization");
  const auth = !header?.trim() ? "missing" : verifyAccessToken(header) ? "valid" : "invalid";
  let payload: unknown;
  try {
    payload = JSON.parse(await request.text());
  } catch {
    logMcp("unparsed", auth, auth === "invalid" ? 401 : 400);
    return auth === "invalid" ? unauthorized() : Response.json({ error: "invalid json" }, { status: 400 });
  }
  if (!isRecord(payload) || Array.isArray(payload)) {
    logMcp("unparsed", auth, auth === "invalid" ? 401 : 400);
    return auth === "invalid" ? unauthorized() : respond(request, 400, rpcError(null, -32600, "Invalid Request"));
  }
  const method = typeof payload.method === "string" ? payload.method : "unknown";
  const id = payload.id ?? null;
  if (auth === "invalid" || (method === "tools/call" && auth !== "valid")) {
    logMcp(method, auth, 401);
    return unauthorized();
  }
  if (!DISCOVERY_METHODS.has(method) && method !== "tools/call") {
    logMcp(method, auth, 200);
    return respond(request, 200, rpcError(id, -32601, "Method not found"));
  }
  if (method === "notifications/initialized") {
    logMcp(method, auth, 202);
    return new Response(null, { status: 202 });
  }
  if (method === "initialize") {
    logMcp(method, auth, 200);
    return respond(request, 200, rpc(id, {
      protocolVersion: protocolVersion(payload.params),
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "qq-daily-bot", version: "1.0.0" },
      instructions: `连接已建立。生成日报时遵守下列规则，但只有 save_daily_report 会把原文保存并主动发到 QQ 群。资源地址是 ${MCP_RESOURCE}。\n${reportInstructions("当天")}`,
    }));
  }
  if (method === "ping") {
    logMcp(method, auth, 200);
    return respond(request, 200, rpc(id, {}));
  }
  if (method === "tools/list") {
    logMcp(method, auth, 200);
    return respond(request, 200, rpc(id, { tools: tools() }));
  }
  if (method === "resources/list" || method === "prompts/list") {
    logMcp(method, auth, 200);
    const key = method === "resources/list" ? "resources" : "prompts";
    return respond(request, 200, rpc(id, { [key]: [] }));
  }
  if (!isRecord(payload.params) || typeof payload.params.name !== "string") {
    logMcp(method, auth, 200);
    return respond(request, 200, rpcError(id, -32602, "Invalid params"));
  }
  const args = isRecord(payload.params.arguments) ? payload.params.arguments : {};
  try {
    if (payload.params.name === "connection_status") {
      logMcp(method, auth, 200);
      return respond(request, 200, rpc(id, { content: [{ type: "text", text: await connectionStatus() }], isError: false }));
    }
    if (typeof args.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(args.date)) {
      logMcp(method, auth, 200);
      return respond(request, 200, rpc(id, { content: [{ type: "text", text: "日期无效" }], isError: true }));
    }
    if (payload.params.name === "read_daily_report") {
      logMcp(method, auth, 200);
      return respond(request, 200, rpc(id, { content: [{ type: "text", text: await readReport(args.date) }], isError: false }));
    }
    if (payload.params.name === "save_daily_report") {
      if (typeof args.content !== "string" || !args.content.trim()) {
        logMcp(method, auth, 200);
        return respond(request, 200, rpc(id, { content: [{ type: "text", text: "正文为空" }], isError: true }));
      }
      const published = await publishDailyReport(args.date, args.content);
      logMcp(method, auth, 200);
      return respond(request, 200, rpc(id, {
        content: [{
          type: "text",
          text: JSON.stringify({
            saved: published.saved,
            status: published.status,
            errCode: published.errCode,
            segmentCount: published.segmentCount,
            message: published.message,
          }),
        }],
        isError: !published.ok,
      }));
    }
    logMcp(method, auth, 200);
    return respond(request, 200, rpc(id, { content: [{ type: "text", text: "未知工具" }], isError: true }));
  } catch (error) {
    console.error(JSON.stringify({ event: "mcp_daily", status: "failed", message: safeLogMessage(error) }));
    logMcp(method, auth, 200);
    const text = error instanceof DailyStoreError ? "日报数据库不可用" : "操作失败";
    return respond(request, 200, rpc(id, { content: [{ type: "text", text }], isError: true }));
  }
}
