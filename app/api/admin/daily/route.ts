import { isBearerAuthorized } from "@/lib/auth";
import { claimSend, finishSend, readSendState, saveReport } from "@/lib/daily-store";
import { DailyStoreError } from "@/lib/db";
import { optionalEnv } from "@/lib/env";
import { isRecord } from "@/lib/guard";
import { safeLogMessage } from "@/lib/redact";
import { QqSendError, sendGroupText } from "@/lib/qq/send";
import { prepareQqMessages } from "@/lib/text";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_CONTENT = 20_000;

function sendOutcome(error: unknown): "failed" | "uncertain" {
  if (error instanceof QqSendError) return error.errCode === "transport" ? "uncertain" : "failed";
  if (error instanceof Error && error.message.startsWith("Failed to get QQ access token")) return "failed";
  return "uncertain";
}

function publicMessage(status: string, errCode: string | null): string {
  if (status === "sent") return "已发到已绑定群。";
  if (status === "already_sent") return "这一天已经向该群发过，没有再次发送。正文已保存，群里发送“日报”会读到当前正文。";
  if (status === "unbound") return "未配置 QQ_GROUP_OPENID，主动发送未执行。正文已保存，群里 @机器人并发送“日报”可被动读取。";
  if (status === "failed" && errCode === "40034105") {
    return "QQ 拒绝了主动消息。正文已保存，可在群里 @机器人发送“日报”被动读取。";
  }
  if (status === "failed") return "发送失败，正文已保留。确认 QQ 主动发群权限后可以再次发送。";
  if (status === "uncertain") return "发送结果不明确，没有自动重发。请先在群里核对是否已经收到。";
  if (status === "in_progress") return "已有一次发送尚未结束，没有开始新的发送。";
  return "已保存。";
}

function logAdmin(action: string, date: string, status: string, errCode: string | null): void {
  console.log(JSON.stringify({ event: "admin_daily", action, date, status, err_code: errCode }));
}

export async function POST(request: Request): Promise<Response> {
  if (!isBearerAuthorized(request.headers.get("authorization"), optionalEnv("ADMIN_TOKEN"))) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(await request.text());
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  if (!isRecord(payload) || (payload.action !== "preview" && payload.action !== "save" && payload.action !== "send")) {
    return Response.json({ error: "invalid action" }, { status: 400 });
  }
  const action = payload.action;
  if (typeof payload.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(payload.date) || typeof payload.content !== "string") {
    return Response.json({ error: "invalid report" }, { status: 400 });
  }
  const date = payload.date;
  const body = payload.content.trim();
  if (!body || body.length > MAX_CONTENT) return Response.json({ error: "invalid report" }, { status: 400 });

  const segments = prepareQqMessages(body);
  if (segments.length === 0) return Response.json({ error: "invalid report" }, { status: 400 });
  if (action === "preview") return Response.json({ ok: true, action, date, segments });

  try {
    await saveReport(date, body);
  } catch (error) {
    console.error(JSON.stringify({ event: "admin_daily", action, date, status: "failed", message: safeLogMessage(error) }));
    const invalid = error instanceof DailyStoreError && error.message === "Invalid report date";
    return Response.json({ error: invalid ? "invalid report" : "日报数据库不可用" }, { status: invalid ? 400 : 500 });
  }

  if (action === "save") {
    const group = optionalEnv("QQ_GROUP_OPENID");
    let sendState: string | null = null;
    if (group) {
      try {
        sendState = await readSendState(date, group);
      } catch (error) {
        console.error(JSON.stringify({ event: "admin_daily", action, date, status: "failed", message: safeLogMessage(error) }));
        return Response.json({ error: "日报数据库不可用" }, { status: 500 });
      }
    }
    logAdmin(action, date, "saved", null);
    return Response.json({ ok: true, action, date, saved: true, sendState, segments, message: "已保存。群里发送“日报”会读取这份原文。" });
  }

  const group = optionalEnv("QQ_GROUP_OPENID");
  if (!group) {
    logAdmin(action, date, "unbound", null);
    return Response.json({
      ok: true,
      action,
      date,
      saved: true,
      status: "unbound",
      segments,
      message: publicMessage("unbound", null),
    });
  }

  let claim: Awaited<ReturnType<typeof claimSend>>;
  try {
    claim = await claimSend(date, group);
  } catch (error) {
    console.error(JSON.stringify({ event: "admin_daily", action, date, status: "failed", message: safeLogMessage(error) }));
    return Response.json({ error: "日报数据库不可用", saved: true }, { status: 500 });
  }
  if (claim !== "send") {
    logAdmin(action, date, claim, null);
    return Response.json(
      { ok: claim === "already_sent", action, date, saved: true, status: claim, message: publicMessage(claim, null) },
      { status: claim === "already_sent" ? 200 : 409 },
    );
  }

  try {
    const segmentCount = await sendGroupText(group, body);
    await finishSend(date, group, "sent");
    logAdmin(action, date, "sent", null);
    return Response.json({
      ok: true,
      action,
      date,
      saved: true,
      status: "sent",
      segments,
      segmentCount,
      message: publicMessage("sent", null),
    });
  } catch (error) {
    const outcome = sendOutcome(error);
    const errCode = error instanceof QqSendError && error.errCode != null ? String(error.errCode) : null;
    try {
      await finishSend(date, group, outcome);
    } catch (updateError) {
      console.error(JSON.stringify({ event: "admin_daily", action, date, status: "uncertain", message: safeLogMessage(updateError) }));
      return Response.json(
        { ok: false, action, date, saved: true, status: "uncertain", message: publicMessage("uncertain", null) },
        { status: 409 },
      );
    }
    console.error(JSON.stringify({ event: "admin_daily", action, date, status: outcome, err_code: errCode, message: safeLogMessage(error) }));
    return Response.json(
      { ok: false, action, date, saved: true, status: outcome, errCode, segments, message: publicMessage(outcome, errCode) },
      { status: outcome === "uncertain" ? 409 : 500 },
    );
  }
}
