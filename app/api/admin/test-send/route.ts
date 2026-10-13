import { isBearerAuthorized } from "@/lib/auth";
import { optionalEnv } from "@/lib/env";
import { isRecord } from "@/lib/guard";
import { safeLogMessage } from "@/lib/redact";
import { sendGroupText } from "@/lib/qq/send";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const DEFAULT_CONTENT = "QQ日报机器人测试成功。";

export async function POST(request: Request): Promise<Response> {
  if (!isBearerAuthorized(request.headers.get("authorization"), optionalEnv("ADMIN_TOKEN"))) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const groupOpenId = optionalEnv("QQ_GROUP_OPENID");
  if (!groupOpenId) {
    return Response.json(
      { error: "QQ_GROUP_OPENID is not configured. Complete group binding first." },
      { status: 500 },
    );
  }

  let content = DEFAULT_CONTENT;
  const raw = await request.text();
  if (raw.trim()) {
    try {
      const payload: unknown = JSON.parse(raw);
      if (isRecord(payload) && typeof payload.content === "string" && payload.content.trim()) {
        content = payload.content;
      }
    } catch {
      return Response.json({ error: "invalid json" }, { status: 400 });
    }
  }

  try {
    const segments = await sendGroupText(groupOpenId, content);
    return Response.json({ ok: true, segments });
  } catch (error) {
    console.error(JSON.stringify({ event: "admin_test_send_failed", message: safeLogMessage(error) }));
    return Response.json({ error: "failed to send message" }, { status: 500 });
  }
}
