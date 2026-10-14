import { beginReply, finishReply } from "@/lib/dedup";
import { requireEnv } from "@/lib/env";
import { isRecord } from "@/lib/guard";
import { answerQuestion } from "@/lib/qa";
import { QqSendError, sendGroupText } from "@/lib/qq/send";
import { signValidation, verifyEventSignature } from "@/lib/qq/signature";
import { safeLogMessage } from "@/lib/redact";
import { planReply } from "@/lib/reply";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const GROUP_EVENTS = new Set(["GROUP_AT_MESSAGE_CREATE", "GROUP_ADD_ROBOT", "GROUP_MSG_RECEIVE"]);
const DUPLICATE_ERR_CODE = "40054005";

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

function messageId(data: Record<string, unknown>): string {
  if (typeof data.id === "string" && data.id) return data.id;
  if (typeof data.msg_id === "string") return data.msg_id;
  return "";
}

async function runAfterAck(task: () => Promise<void>): Promise<void> {
  if (process.env.VITEST) {
    await task();
    return;
  }
  const { after } = await import("next/server");
  after(() =>
    task().catch((error: unknown) => {
      console.error(JSON.stringify({ event: "qq_webhook_failed", message: safeLogMessage(error) }));
    }),
  );
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

  const msgId = messageId(data);
  if (!groupOpenId || !msgId) {
    logWebhook(type, "missing_target");
    return;
  }
  if (!beginReply(msgId)) {
    logWebhook(type, "duplicate", { result: "skipped" });
    return;
  }

  const content = typeof data.content === "string" ? data.content : "";
  const plan = planReply(content);
  let text = plan.branch === "reply_qa" ? "" : plan.text;
  let model: "skipped" | "unconfigured" | "ok" | "failed" = "skipped";
  let liveData = 0;
  if (plan.branch === "reply_qa") {
    const answer = await answerQuestion(content);
    text = answer.text;
    model = answer.model;
    liveData = answer.liveData ? 1 : 0;
  }

  try {
    const segments = await sendGroupText(groupOpenId, text, { msgId });
    finishReply(msgId, true);
    logWebhook(type, plan.branch, { result: "sent", segments, model, live_data: liveData });
  } catch (error) {
    const status = error instanceof QqSendError ? error.status : null;
    const errCode = error instanceof QqSendError ? error.errCode : null;
    const duplicate = String(errCode) === DUPLICATE_ERR_CODE;
    finishReply(msgId, duplicate);
    logWebhook(type, duplicate ? "duplicate" : plan.branch, {
      result: duplicate ? "duplicate" : "failed",
      status,
      err_code: errCode,
      model,
      live_data: liveData,
    });
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
  await runAfterAck(() => handleGroupEvent(payload));
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
