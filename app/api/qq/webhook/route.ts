import { requireEnv } from "@/lib/env";
import { isRecord } from "@/lib/guard";
import { safeLogMessage } from "@/lib/redact";
import { sendGroupText } from "@/lib/qq/send";
import { signValidation, verifyEventSignature } from "@/lib/qq/signature";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const GROUP_EVENTS = new Set(["GROUP_AT_MESSAGE_CREATE", "GROUP_ADD_ROBOT", "GROUP_MSG_RECEIVE"]);
const BIND_REPLY = "机器人连接成功，已识别当前群聊。";
const HELLO_REPLY = "你好，已收到你的消息，群消息接收和回复测试成功。";

function badRequest(): Response {
  return Response.json({ error: "invalid payload" }, { status: 400 });
}

function handleValidation(payload: Record<string, unknown>): Response {
  if (!isRecord(payload.d)) return badRequest();
  const plainToken = payload.d.plain_token;
  const eventTs = payload.d.event_ts;
  if (typeof plainToken !== "string" || (typeof eventTs !== "string" && typeof eventTs !== "number")) {
    return badRequest();
  }
  const signature = signValidation(requireEnv("QQ_APP_SECRET"), String(eventTs), plainToken);
  return Response.json({ plain_token: plainToken, signature });
}

function logWebhook(type: string, branch: string, extra?: Record<string, string | number | null>): void {
  console.log(JSON.stringify({ event: "qq_webhook_event", type, branch, ...extra }));
}

function replyFor(content: string): { branch: "reply_bind" | "reply_hello"; text: string } | null {
  const text = content.replace(/[\s\u200b\u200c\u200d\ufeff]/g, "");
  if (text.includes("绑定日报") || text.includes("测试")) {
    return { branch: "reply_bind", text: BIND_REPLY };
  }
  if (text.includes("你好")) {
    return { branch: "reply_hello", text: HELLO_REPLY };
  }
  return null;
}

async function handleGroupEvent(payload: Record<string, unknown>): Promise<void> {
  const type = typeof payload.t === "string" ? payload.t : "";
  if (!isRecord(payload.d)) {
    logWebhook(type, "ignore_payload");
    return;
  }
  const data = payload.d;
  const groupOpenId = typeof data.group_openid === "string" ? data.group_openid : "";
  if (GROUP_EVENTS.has(type) && groupOpenId && !/[\r\n]/.test(groupOpenId)) {
    console.log(`GROUP_OPENID_CAPTURED=${groupOpenId}`);
  }
  if (type !== "GROUP_AT_MESSAGE_CREATE") {
    logWebhook(type, "ignore_event");
    return;
  }

  const content = typeof data.content === "string" ? data.content : "";
  const reply = replyFor(content);
  if (!reply) {
    logWebhook(type, "ignore_command");
    return;
  }

  const msgId =
    typeof data.id === "string" && data.id
      ? data.id
      : typeof data.msg_id === "string"
        ? data.msg_id
        : "";
  if (!groupOpenId || !msgId) {
    logWebhook(type, "missing_target");
    console.error(
      JSON.stringify({ event: "qq_webhook_reply_skipped", type, branch: reply.branch, reason: "missing group_openid or message id" }),
    );
    return;
  }

  try {
    const segments = await sendGroupText(groupOpenId, reply.text, { msgId });
    logWebhook(type, reply.branch, { result: "sent", segments });
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "qq_webhook_reply_failed",
        type,
        branch: reply.branch,
        result: "failed",
        message: safeLogMessage(error),
      }),
    );
  }
}

async function handleDispatch(
  request: Request,
  rawBody: string,
  payload: Record<string, unknown>,
): Promise<Response> {
  const signature = request.headers.get("X-Signature-Ed25519");
  const timestamp = request.headers.get("X-Signature-Timestamp");
  if (!signature || !timestamp) {
    return Response.json({ error: "invalid signature" }, { status: 401 });
  }
  const valid = verifyEventSignature(requireEnv("QQ_APP_SECRET"), timestamp, rawBody, signature);
  if (!valid) return Response.json({ error: "invalid signature" }, { status: 401 });
  await handleGroupEvent(payload);
  return Response.json({ op: 12 });
}

export async function POST(request: Request): Promise<Response> {
  const rawBody = await request.text();
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return badRequest();
  }
  if (!isRecord(payload) || typeof payload.op !== "number") return badRequest();

  try {
    if (payload.op === 13) return handleValidation(payload);
    if (payload.op === 0) return await handleDispatch(request, rawBody, payload);
  } catch (error) {
    console.error(JSON.stringify({ event: "qq_webhook_failed", message: safeLogMessage(error) }));
    return Response.json({ error: "server configuration error" }, { status: 500 });
  }
  return Response.json({ error: "unsupported opcode" }, { status: 400 });
}
