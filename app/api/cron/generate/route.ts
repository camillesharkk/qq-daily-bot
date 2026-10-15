import { isBearerAuthorized } from "@/lib/auth";
import { shanghaiDate } from "@/lib/date";
import { prepareReport } from "@/lib/daily-store";
import { DailyStoreError } from "@/lib/db";
import { optionalEnv } from "@/lib/env";
import { createDailyReport } from "@/lib/report";
import { safeLogMessage } from "@/lib/redact";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: Request): Promise<Response> {
  if (!isBearerAuthorized(request.headers.get("authorization"), optionalEnv("CRON_SECRET"))) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const date = shanghaiDate();
  try {
    const prepared = await prepareReport(date, async () => {
      const created = await createDailyReport(date, "daily");
      if (!created.ok) throw new Error(created.reason);
      return created.text;
    });
    console.log(JSON.stringify({ event: "daily_generate", date, status: prepared.status }));
    if (prepared.status === "ready") {
      return Response.json({ ok: true, status: prepared.generate === "reused" ? "ready" : "created", date, chars: Array.from(prepared.content).length });
    }
    return Response.json({ ok: prepared.status !== "failed", status: prepared.status, date });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "failed";
    console.error(JSON.stringify({ event: "daily_generate", date, status: "failed", reason: safeLogMessage(reason) }));
    if (error instanceof DailyStoreError) return Response.json({ ok: false, status: "unavailable", date });
    return Response.json({ ok: false, status: "failed", date, reason });
  }
}
