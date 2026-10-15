import { isBearerAuthorized } from "@/lib/auth";
import { shanghaiDate } from "@/lib/date";
import { readReadyReport } from "@/lib/daily-store";
import { DailyStoreError } from "@/lib/db";
import { optionalEnv } from "@/lib/env";
import { publishDailyReport } from "@/lib/publish";
import { safeLogMessage } from "@/lib/redact";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request): Promise<Response> {
  if (!isBearerAuthorized(request.headers.get("authorization"), optionalEnv("CRON_SECRET"))) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const date = shanghaiDate();
  try {
    const content = await readReadyReport(date);
    if (!content) return Response.json({ ok: true, status: "missing", date });
    const result = await publishDailyReport(date, content);
    console.log(JSON.stringify({
      event: "daily_cron",
      date,
      status: result.status,
      err_code: result.errCode,
      segments: result.segmentCount,
    }));
    return Response.json({ ok: result.ok, status: result.status, errCode: result.errCode, date });
  } catch (error) {
    if (error instanceof DailyStoreError) {
      console.error(JSON.stringify({ event: "daily_cron", date, status: "unavailable", message: safeLogMessage(error) }));
      return Response.json({ ok: false, status: "unavailable", date });
    }
    throw error;
  }
}
