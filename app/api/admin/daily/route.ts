import { isBearerAuthorized } from "@/lib/auth";
import { readReadyReport, readSendRecord, readSendState, saveReport } from "@/lib/daily-store";
import { DailyStoreError } from "@/lib/db";
import { optionalEnv } from "@/lib/env";
import { isRecord } from "@/lib/guard";
import { publishDailyReport } from "@/lib/publish";
import { safeLogMessage } from "@/lib/redact";
import { prepareQqMessages } from "@/lib/text";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_CONTENT = 20_000;

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
  if (!isRecord(payload) || (payload.action !== "preview" && payload.action !== "save" && payload.action !== "send" && payload.action !== "status")) {
    return Response.json({ error: "invalid action" }, { status: 400 });
  }
  const action = payload.action;
  if (typeof payload.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(payload.date)) {
    return Response.json({ error: "invalid report" }, { status: 400 });
  }
  const date = payload.date;
  if (action === "status") {
    try {
      const content = await readReadyReport(date);
      const group = optionalEnv("QQ_GROUP_OPENID");
      const record = group ? await readSendRecord(date, group) : null;
      const sendState = record?.state ?? null;
      return Response.json({
        ok: true,
        action,
        date,
        content,
        sendState,
        delivery: record?.state === "sent" && !record.receipts ? "unverified" : null,
        bound: Boolean(group),
        segments: content ? prepareQqMessages(content) : [],
        message: content ? "已读取保存的原文。" : "这一天还没有保存日报。",
      });
    } catch (error) {
      console.error(JSON.stringify({ event: "admin_daily", action, date, status: "failed", message: safeLogMessage(error) }));
      return Response.json({ error: "日报数据库不可用" }, { status: 500 });
    }
  }
  if (typeof payload.content !== "string") return Response.json({ error: "invalid report" }, { status: 400 });
  const body = payload.content.trim();
  if (!body || body.length > MAX_CONTENT) return Response.json({ error: "invalid report" }, { status: 400 });

  const segments = prepareQqMessages(body);
  if (segments.length === 0) return Response.json({ error: "invalid report" }, { status: 400 });
  if (action === "preview") return Response.json({ ok: true, action, date, segments });

  if (action === "save") {
    try {
      await saveReport(date, body);
      const group = optionalEnv("QQ_GROUP_OPENID");
      const sendState = group ? await readSendState(date, group) : null;
      logAdmin(action, date, "saved", null);
      return Response.json({ ok: true, action, date, saved: true, sendState, segments, message: "已保存。群里发送“日报”会读取这份原文。" });
    } catch (error) {
      console.error(JSON.stringify({ event: "admin_daily", action, date, status: "failed", message: safeLogMessage(error) }));
      const invalid = error instanceof DailyStoreError && error.message === "Invalid report date";
      return Response.json({ error: invalid ? "invalid report" : "日报数据库不可用" }, { status: invalid ? 400 : 500 });
    }
  }

  try {
    const published = await publishDailyReport(date, body);
    logAdmin(action, date, published.status, published.errCode);
    return Response.json({
      ok: published.ok,
      action,
      date,
      saved: published.saved,
      status: published.status,
      errCode: published.errCode,
      segments: published.segments,
      segmentCount: published.segmentCount,
      message: published.message,
    }, { status: published.httpStatus });
  } catch (error) {
    console.error(JSON.stringify({ event: "admin_daily", action, date, status: "failed", message: safeLogMessage(error) }));
    return Response.json({ error: "日报数据库不可用" }, { status: 500 });
  }
}
