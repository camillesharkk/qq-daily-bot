import { isBearerAuthorized } from "@/lib/auth";
import { markSent, readDaily, saveGenerated } from "@/lib/daily-store";
import { shanghaiDate } from "@/lib/date";
import { optionalEnv } from "@/lib/env";
import { safeLogMessage } from "@/lib/redact";
import { buildDailyReport } from "@/lib/report";
import { sendGroupText } from "@/lib/qq/send";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request): Promise<Response> {
  if (!isBearerAuthorized(request.headers.get("authorization"), optionalEnv("CRON_SECRET"))) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const groupOpenId = optionalEnv("QQ_GROUP_OPENID");
  if (!groupOpenId) {
    return Response.json(
      { error: "QQ_GROUP_OPENID is not configured. Complete group binding first." },
      { status: 500 },
    );
  }

  const date = shanghaiDate();
  const existing = readDaily(date);
  if (existing?.sent) {
    console.log(JSON.stringify({ event: "daily_cron", date, generate: "skipped", send: "skipped" }));
    return Response.json({ ok: true, segments: 0, date, status: "already_sent" });
  }

  let generate: "created" | "reused" = existing ? "reused" : "created";
  let report = existing?.content;
  if (!report) {
    try {
      report = await buildDailyReport();
      saveGenerated(date, report);
      generate = "created";
    } catch (error) {
      console.error(JSON.stringify({ event: "daily_cron", date, generate: "failed", send: "skipped", message: safeLogMessage(error) }));
      return Response.json({ error: "Failed to generate or send the daily report" }, { status: 500 });
    }
  }

  try {
    const segments = await sendGroupText(groupOpenId, report);
    markSent(date);
    console.log(JSON.stringify({ event: "daily_cron", date, generate, send: "sent", segments }));
    return Response.json({ ok: true, segments, date, status: "sent" });
  } catch (error) {
    console.error(JSON.stringify({ event: "daily_cron", date, generate, send: "failed", message: safeLogMessage(error) }));
    return Response.json({ error: "Failed to generate or send the daily report" }, { status: 500 });
  }
}
