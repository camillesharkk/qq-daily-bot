import { claimSend, finishSend, readSendRecord, saveReport } from "@/lib/daily-store";
import { optionalEnv } from "@/lib/env";
import { safeLogMessage } from "@/lib/redact";
import { QqReceipt, QqSendError, sendGroupText } from "@/lib/qq/send";
import { prepareQqMessages } from "@/lib/text";

export type PublishStatus = "unbound" | "sent" | "already_sent" | "in_progress" | "uncertain" | "failed" | "partial" | "exhausted";

export type PublishResult = {
  ok: boolean;
  saved: boolean;
  status: PublishStatus;
  errCode: string | null;
  segmentCount: number | null;
  segments: string[];
  message: string;
  httpStatus: number;
};

function receiptLog(prior: string | null, fresh: readonly QqReceipt[]): string | null {
  let previous: unknown[] = [];
  if (prior) {
    try {
      const parsed: unknown = JSON.parse(prior);
      if (Array.isArray(parsed)) previous = parsed;
    } catch {
      previous = [];
    }
  }
  const all = [...previous, ...fresh];
  return all.length > 0 ? JSON.stringify(all) : null;
}

function sendOutcome(error: unknown): "failed" | "uncertain" {
  if (error instanceof QqSendError) return error.errCode === "transport" ? "uncertain" : "failed";
  if (error instanceof Error && error.message.startsWith("Failed to get QQ access token")) return "failed";
  return "uncertain";
}

export function publishMessage(status: string, errCode: string | null): string {
  if (status === "sent") return "已发到已绑定群。";
  if (status === "already_sent") return "这一天已经向该群发过，没有再次发送。正文已保存，群里发送“日报”会读到当前正文。";
  if (status === "unbound") return "未配置 QQ_GROUP_OPENID，主动发送未执行。正文已保存，群里 @机器人并发送“日报”可被动读取。";
  if (status === "failed" && errCode === "40034105") {
    return "QQ 拒绝了主动消息。正文已保存，可在群里 @机器人发送“日报”或“今日日报”被动读取。";
  }
  if (status === "partial") return "只发出了前面的分段，没有把整篇标成发送成功。";
  if (status === "exhausted") return "这一天的发送重试已到上限，没有继续发。";
  if (status === "failed") return "发送失败，正文已保留。确认 QQ 主动发群权限后可以再次发送。";
  if (status === "uncertain") return "发送结果不明确，没有自动重发。请先在群里核对是否已经收到。";
  if (status === "in_progress") return "已有一次发送尚未结束，没有开始新的发送。";
  return "已保存。";
}

export async function publishDailyReport(date: string, content: string): Promise<PublishResult> {
  const segments = prepareQqMessages(content);
  await saveReport(date, content);
  const group = optionalEnv("QQ_GROUP_OPENID");
  if (!group) {
    return { ok: true, saved: true, status: "unbound", errCode: null, segmentCount: null, segments, message: publishMessage("unbound", null), httpStatus: 200 };
  }
  const claim = await claimSend(date, group);
  if (claim !== "send") {
    return {
      ok: claim === "already_sent",
      saved: true,
      status: claim,
      errCode: null,
      segmentCount: null,
      segments: [],
      message: publishMessage(claim, null),
      httpStatus: claim === "already_sent" ? 200 : 409,
    };
  }
  const prior = await readSendRecord(date, group);
  const startIndex = prior?.segmentsSent ?? 0;
  const receipts: QqReceipt[] = [];
  try {
    await sendGroupText(group, content, { startIndex, receipts, requestId: date });
    const sentCount = startIndex + receipts.length;
    const logged = receiptLog(prior?.receipts ?? null, receipts);
    if (sentCount !== segments.length) {
      await finishSend(date, group, "partial", sentCount, logged);
      return { ok: false, saved: true, status: "partial", errCode: null, segmentCount: sentCount, segments, message: publishMessage("partial", null), httpStatus: 500 };
    }
    await finishSend(date, group, "sent", sentCount, logged);
    return { ok: true, saved: true, status: "sent", errCode: null, segmentCount: sentCount, segments, message: publishMessage("sent", null), httpStatus: 200 };
  } catch (error) {
    const errCode = error instanceof QqSendError && error.errCode != null ? String(error.errCode) : null;
    const sentCount = startIndex + receipts.length;
    const outcome = errCode === "40034105" || errCode === "missing_id"
      ? sentCount > 0 ? "partial" : "failed"
      : sentCount > 0 && sentCount < segments.length ? "partial" : sendOutcome(error);
    try {
      await finishSend(date, group, outcome === "partial" ? "partial" : outcome === "uncertain" ? "uncertain" : "failed", startIndex + receipts.length, receiptLog(prior?.receipts ?? null, receipts));
    } catch (updateError) {
      console.error(JSON.stringify({ event: "daily_publish", date, status: "uncertain", message: safeLogMessage(updateError) }));
      return { ok: false, saved: true, status: "uncertain", errCode: null, segmentCount: null, segments, message: publishMessage("uncertain", null), httpStatus: 409 };
    }
    console.error(JSON.stringify({ event: "daily_publish", date, status: outcome, err_code: errCode, segments_sent: startIndex + receipts.length }));
    return {
      ok: false,
      saved: true,
      status: outcome,
      errCode,
      segmentCount: startIndex + receipts.length,
      segments,
      message: publishMessage(outcome, errCode),
      httpStatus: outcome === "uncertain" ? 409 : 500,
    };
  }
}
