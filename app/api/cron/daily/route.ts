import { isBearerAuthorized } from "@/lib/auth";
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

  try {
    const report = await buildDailyReport();
    const segments = await sendGroupText(groupOpenId, report);
    return Response.json({ ok: true, segments, date: shanghaiDate() });
  } catch (error) {
    console.error(JSON.stringify({ event: "daily_cron_failed", message: safeLogMessage(error) }));
    return Response.json({ error: "Failed to generate or send the daily report" }, { status: 500 });
  }
}
