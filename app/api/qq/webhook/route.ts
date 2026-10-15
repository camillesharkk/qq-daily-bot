import { readReadyReport } from "@/lib/daily-store";
import { DailyStoreError } from "@/lib/db";
import { shanghaiDate } from "@/lib/date";
import { finishReply, hasReply } from "@/lib/dedup";
import { requireEnv } from "@/lib/env";
import { isRecord } from "@/lib/guard";
import { allowQuestion } from "@/lib/limit";
import { answerQuestion, QA_BUSY } from "@/lib/qa";
import { QqSendError, sendGroupText } from "@/lib/qq/send";
import { signValidation, verifyEventSignature } from "@/lib/qq/signature";
import { safeLogMessage } from "@/lib/redact";
import { DAILY_MISSING, planReply } from "@/lib/reply";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const GROUP_EVENTS = new Set(["GROUP_AT_MESSAGE_CREATE", "GROUP_ADD_ROBOT", "GROUP_MSG_RECEIVE"]);
const DAILY_STORE_UNAVAILABLE = "日报存储暂时不可用，请稍后再试。";

async function savedReport(date: string): Promise<string | null | "unavailable"> {
  try {
    return await readReadyReport(date);
  } catch (error) {
    if (error instanceof DailyStoreError) return "unavailable";
    throw error;
  }
}
const DUPLICATE_ERR_CODE = "40054005";

function deploymentSha(): string {
  const sha = process.env.VERCEL_GIT_COMMIT_SHA;
  return typeof sha === "string" && /^[0-9a-f]{7,40}$/i.test(sha) ? sha : "local";
}

function logWebhook(type: string, branch: string, extra?: Record<string, string | number | null>): void {
  console.log(JSON.stringify({ event: "qq_webhook_event", sha: deploymentSha(), type, branch, ...extra }));
}

function badRequest(): Response {
  logWebhook("", "invalid_payload", { op: null });
  return Response.json({ error: "invalid payload" }, { status: 400 });
}

function handleValidation(payload: Record<string, unknown>): Response {
  if (!isRecord(payload.d)) return badRequest();
  const plainToken = payload.d.plain_token;
  const eventTs = payload.d.event_ts;
  if (typeof plainToken !== "string" || (typeof eventTs !== "string" && typeof eventTs !== "number")) {
    return badRequest();
  }
  logWebhook("", "verification", { op: 13 });
  const signature = signValidation(requireEnv("QQ_APP_SECRET"), String(eventTs), plainToken);
  return Response.json({ plain_token: plainToken, signature });
}

function messageId(data: Record<string, unknown>): string {
  if (typeof data.id === "string" && data.id) return data.id;
  if (typeof data.msg_id === "string") return data.msg_id;
  return "";
}

async function runAfterAck(type: string, task: () => Promise<void>): Promise<void> {
  logWebhook(type, "after", { result: "scheduled" });
  const run = async (): Promise<void> => {
    logWebhook(type, "after", { result: "started" });
    try {
      await task();
      logWebhook(type, "after", { result: "finished" });
    } catch (error: unknown) {
      logWebhook(type, "after", { result: "failed" });
      console.error(JSON.stringify({ event: "qq_webhook_failed", message: safeLogMessage(error) }));
    }
  };
  if (process.env.VITEST) {
    await run();
    return;
  }
  const { after } = await import("next/server");
  after(() => run());
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
    logWebhook(type, "missing_target", { result: "skipped" });
    return;
  }
  if (hasReply(msgId)) {
    logWebhook(type, "duplicate", { result: "skipped" });
    return;
  }

  const content = typeof data.content === "string" ? data.content : "";
  const requestId = crypto.randomUUID().slice(0, 8);
  const plan = planReply(content);
  let text = "";
  let model: "skipped" | "unconfigured" | "ok" | "failed" | "limited" = "skipped";
  let liveData = 0;
  if (plan.branch === "reply_daily") {
    const saved = await savedReport(shanghaiDate());
    text = saved === "unavailable" ? DAILY_STORE_UNAVAILABLE : saved ?? DAILY_MISSING;
  } else if (plan.branch === "reply_qa") {
    if (!allowQuestion(groupOpenId)) {
      text = QA_BUSY;
      model = "limited";
    } else {
      const saved = plan.useReport ? await savedReport(shanghaiDate()) : null;
      if (saved === "unavailable") {
        text = DAILY_STORE_UNAVAILABLE;
      } else {
        const answer = await answerQuestion(content, saved ?? undefined, requestId);
        text = answer.text;
        model = answer.model;
        liveData = answer.liveData ? 1 : 0;
      }
    }
  } else {
    text = plan.text;
  }

  try {
    const segments = await sendGroupText(groupOpenId, text, { msgId, requestId });
    finishReply(msgId, true);
    logWebhook(type, plan.branch, { result: "sent", segments, model, live_data: liveData, request_id: requestId });
  } catch (error) {
    const status = error instanceof QqSendError ? error.status : null;
    const errCode = error instanceof QqSendError ? error.errCode : null;
    const sent = error instanceof QqSendError ? error.sent : 0;
    const duplicate = String(errCode) === DUPLICATE_ERR_CODE;
    finishReply(msgId, duplicate);
    logWebhook(type, duplicate ? "duplicate" : plan.branch, {
      result: duplicate ? "duplicate" : "failed",
      status,
      err_code: errCode,
      segments_sent: sent,
      model,
      live_data: liveData,
      request_id: requestId,
    });
  }
}

async function handleDispatch(
  request: Request,
  rawBody: string,
  payload: Record<string, unknown>,
): Promise<Response> {
  const type = typeof payload.t === "string" ? payload.t : "";
  const signature = request.headers.get("X-Signature-Ed25519");
  const timestamp = request.headers.get("X-Signature-Timestamp");
  if (!signature || !timestamp) {
    logWebhook(type, "missing_signature", { op: 0, result: "invalid" });
    return Response.json({ error: "invalid signature" }, { status: 401 });
  }
  const valid = verifyEventSignature(requireEnv("QQ_APP_SECRET"), timestamp, rawBody, signature);
  logWebhook(type, "signature", { op: 0, result: valid ? "valid" : "invalid" });
  if (!valid) return Response.json({ error: "invalid signature" }, { status: 401 });
  await runAfterAck(type, () => handleGroupEvent(payload));
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
  const type = typeof payload.t === "string" ? payload.t : "";
  logWebhook(type, "received", { op: payload.op });

  try {
    if (payload.op === 13) return handleValidation(payload);
    if (payload.op === 0) return await handleDispatch(request, rawBody, payload);
  } catch (error) {
    logWebhook(type, "configuration", { op: payload.op, result: "failed" });
    console.error(JSON.stringify({ event: "qq_webhook_failed", message: safeLogMessage(error) }));
    return Response.json({ error: "server configuration error" }, { status: 500 });
  }
  logWebhook(type, "unsupported_opcode", { op: payload.op });
  return Response.json({ error: "unsupported opcode" }, { status: 400 });
}
