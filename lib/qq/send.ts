import { createHash } from "node:crypto";
import { qqApiBase, requireEnv } from "@/lib/env";
import { isRecord } from "@/lib/guard";
import { safeLogMessage } from "@/lib/redact";
import { prepareQqMessages } from "@/lib/text";
import { clearAccessTokenCache, getAccessToken } from "@/lib/qq/token";

const GAP_MS = 300;
const TIMEOUT_MS = 15_000;

export class QqSendError extends Error {
  readonly status: number;
  readonly errCode: string | number | null;
  readonly sent: number;

  constructor(status: number, errCode: string | number | null, sent = 0) {
    super(`QQ message send failed: HTTP ${status}`);
    this.name = "QqSendError";
    this.status = status;
    this.errCode = errCode;
    this.sent = sent;
  }
}

export type SendGroupTextOptions = {
  msgId?: string;
  msgSeq?: number;
  gapMs?: number;
  requestId?: string;
};

const DUPLICATE_ERR_CODE = "40054005";
const progress = new Map<string, number>();

export function resetSendProgress(): void {
  progress.clear();
}

function progressKey(msgId: string, segments: string[]): string {
  const digest = createHash("sha256").update(segments.join("\u0000")).digest("hex").slice(0, 12);
  return `${msgId}:${digest}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function readQqError(raw: string, headers: Headers): { errCode: string | number | null; message: string; traceId: string | null } {
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
  return { errCode, message, traceId };
}

function logQqFailure(status: number, raw: string, headers: Headers): string | number | null {
  const parsed = readQqError(raw, headers);
  console.error(
    JSON.stringify({
      event: "qq_send_failed",
      status,
      err_code: parsed.errCode,
      message: safeLogMessage(parsed.message),
      trace_id: parsed.traceId,
    }),
  );
  return parsed.errCode;
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

  let response: Response;
  try {
    response = await fetch(url, {
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
  } catch {
    throw new QqSendError(0, "transport");
  }

  if (response.status === 401 && allowRetry) {
    const raw = await response.text();
    logQqFailure(response.status, raw, response.headers);
    clearAccessTokenCache();
    await deliver(groupOpenId, content, msgSeq, msgId, false);
    return;
  }

  if (!response.ok) {
    const raw = await response.text();
    const errCode = logQqFailure(response.status, raw, response.headers);
    throw new QqSendError(response.status, errCode);
  }

  console.log(JSON.stringify({ event: "qq_send_ok", status: response.status, msg_seq: msgSeq }));
}

function logSegment(
  requestId: string | undefined,
  index: number,
  total: number,
  msgSeq: number,
  status: number,
  errCode: string | number | null,
): void {
  console.log(JSON.stringify({
    event: "qq_segment",
    request_id: requestId ?? null,
    index,
    total,
    msg_seq: msgSeq,
    status,
    err_code: errCode,
  }));
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
  const requestId = options?.requestId;
  const formattedChars = segments.reduce((sum, segment) => sum + Array.from(segment).length, 0);
  console.log(JSON.stringify({
    event: "qq_outbound",
    request_id: requestId ?? null,
    chars: Array.from(content).length,
    formatted_chars: formattedChars,
    segments: segments.length,
  }));

  const key = options?.msgId ? progressKey(options.msgId, segments) : "";
  const gap = options?.gapMs ?? GAP_MS;
  let index = key ? progress.get(key) ?? 0 : 0;
  let duplicates = 0;
  const seqBase = options?.msgSeq ?? 1;
  while (index < segments.length) {
    const segment = segments[index];
    if (!segment?.trim()) {
      index += 1;
      continue;
    }
    if (index > 0 && gap > 0) await delay(gap);
    const msgSeq = seqBase + index;
    try {
      await deliver(groupOpenId, segment, msgSeq, options?.msgId, true);
      logSegment(requestId, index + 1, segments.length, msgSeq, 200, null);
    } catch (error) {
      const status = error instanceof QqSendError ? error.status : 0;
      const errCode = error instanceof QqSendError ? error.errCode : null;
      if (String(errCode) === DUPLICATE_ERR_CODE) {
        duplicates += 1;
        logSegment(requestId, index + 1, segments.length, msgSeq, status, errCode);
      } else {
        logSegment(requestId, index + 1, segments.length, msgSeq, status, errCode);
        if (key) progress.set(key, index);
        throw new QqSendError(status, errCode, index);
      }
    }
    index += 1;
    if (key) progress.set(key, index);
  }
  if (duplicates > 0 && duplicates === segments.length) {
    throw new QqSendError(400, DUPLICATE_ERR_CODE, segments.length);
  }
  return segments.length;
}
