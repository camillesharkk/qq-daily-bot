import { qqApiBase, requireEnv } from "@/lib/env";
import { isRecord } from "@/lib/guard";
import { safeLogMessage } from "@/lib/redact";
import { prepareQqMessages } from "@/lib/text";
import { clearAccessTokenCache, getAccessToken } from "@/lib/qq/token";

const GAP_MS = 300;
const TIMEOUT_MS = 15_000;

export type SendGroupTextOptions = {
  msgId?: string;
  msgSeq?: number;
  gapMs?: number;
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function logQqFailure(status: number, raw: string, headers: Headers): void {
  let errCode: string | number | null = null;
  let message = "";
  let traceId = headers.get("x-tps-trace-id") ?? headers.get("x-trace-id");
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed)) {
      const code = parsed.err_code ?? parsed.code;
      if (typeof code === "string" || typeof code === "number") errCode = code;
      if (typeof parsed.message === "string") message = parsed.message;
      if (typeof parsed.trace_id === "string") traceId = parsed.trace_id;
    }
  } catch {
    message = "";
  }
  console.error(
    JSON.stringify({
      event: "qq_send_failed",
      status,
      err_code: errCode,
      message: safeLogMessage(message),
      trace_id: traceId,
    }),
  );
}

async function deliver(
  groupOpenId: string,
  content: string,
  msgSeq: number,
  msgId: string | undefined,
  allowRetry: boolean,
): Promise<void> {
  const token = await getAccessToken();
  const appId = requireEnv("QQ_APP_ID");
  const url = `${qqApiBase()}/v2/groups/${encodeURIComponent(groupOpenId)}/messages`;
  const payload: Record<string, string | number> = {
    msg_type: 0,
    content,
    msg_seq: msgSeq,
  };
  if (msgId) payload.msg_id = msgId;

  const response = await fetch(url, {
    method: "POST",
    cache: "no-store",
    headers: {
      Authorization: `QQBot ${token}`,
      "Content-Type": "application/json",
      "X-Union-Appid": appId,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (response.status === 401 && allowRetry) {
    const raw = await response.text();
    logQqFailure(response.status, raw, response.headers);
    clearAccessTokenCache();
    await deliver(groupOpenId, content, msgSeq, msgId, false);
    return;
  }

  if (!response.ok) {
    const raw = await response.text();
    logQqFailure(response.status, raw, response.headers);
    throw new Error(`QQ message send failed: HTTP ${response.status}`);
  }
}

export async function sendGroupText(
  groupOpenId: string,
  content: string,
  options?: SendGroupTextOptions,
): Promise<number> {
  const segments = prepareQqMessages(content);
  if (segments.length === 0) {
    throw new Error("Refusing to send empty QQ message");
  }

  const gap = options?.gapMs ?? GAP_MS;
  let seq = options?.msgSeq ?? 1;
  let sent = 0;
  for (const segment of segments) {
    if (!segment.trim()) continue;
    if (sent > 0 && gap > 0) await delay(gap);
    await deliver(groupOpenId, segment, seq, options?.msgId, true);
    seq += 1;
    sent += 1;
  }
  if (sent === 0) throw new Error("Refusing to send empty QQ message");
  return sent;
}
