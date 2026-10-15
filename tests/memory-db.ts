import type { DbQuery } from "@/lib/db";

type Report = {
  content: string | null;
  state: "generating" | "ready" | "failed";
  claimId: string | null;
  claimedAt: string | null;
  attempts: number;
};

type Send = {
  state: "sending" | "sent" | "failed" | "uncertain" | "partial";
  segmentsSent: number;
  receipts: string | null;
  attempts: number;
};

function tag(text: string): string {
  const found = text.match(/\/\* ([a-z_]+) \*\//);
  if (!found?.[1]) throw new Error("Query is missing a statement tag");
  return found[1];
}

export function createMemoryQuery(): DbQuery {
  const reports = new Map<string, Report>();
  const sends = new Map<string, Send>();
  const sendKey = (date: string, group: string) => `${date}\n${group}`;

  return async (text, params) => {
    const name = tag(text);
    const date = String(params[0]);
    if (name === "claim_report") {
      if (reports.has(date)) return [];
      reports.set(date, { content: null, state: "generating", claimId: String(params[1]), claimedAt: String(params[2]), attempts: 0 });
      return [{ claim_id: params[1] }];
    }
    if (name === "takeover_report") {
      const report = reports.get(date);
      if (!report || report.state !== "generating" || !report.claimedAt || !(report.claimedAt < String(params[3]))) return [];
      report.claimId = String(params[1]);
      report.claimedAt = String(params[2]);
      return [{ claim_id: params[1] }];
    }
    if (name === "save_report") {
      const existing = reports.get(date);
      reports.set(date, { content: String(params[1]), state: "ready", claimId: null, claimedAt: null, attempts: existing?.attempts ?? 0 });
      return [{ report_date: date }];
    }
    if (name === "read_report") {
      const report = reports.get(date);
      return report ? [{ content: report.content, state: report.state, attempts: report.attempts }] : [];
    }
    if (name === "commit_report") {
      const report = reports.get(date);
      if (!report || report.state !== "generating" || report.claimId !== String(params[2])) return [];
      report.content = String(params[1]);
      report.state = "ready";
      report.claimId = null;
      return [{ report_date: date }];
    }
    if (name === "release_report") {
      const report = reports.get(date);
      if (!report || report.state !== "generating" || report.claimId !== String(params[1])) return [];
      reports.delete(date);
      return [{ report_date: date }];
    }
    if (name === "fail_report") {
      const report = reports.get(date);
      if (!report || report.state !== "generating" || report.claimId !== String(params[1])) return [];
      report.state = "failed";
      report.content = String(params[2]);
      report.claimId = null;
      report.claimedAt = null;
      report.attempts += 1;
      return [{ report_date: date }];
    }
    if (name === "retry_failed_report") {
      const report = reports.get(date);
      if (!report || report.state !== "failed" || report.attempts >= 2) return [];
      report.state = "generating";
      report.content = null;
      report.claimId = String(params[1]);
      report.claimedAt = String(params[2]);
      return [{ claim_id: params[1] }];
    }
    if (name === "claim_send") {
      if (!reports.has(date)) throw new Error("insert or update on table daily_sends violates foreign key constraint");
      const key = sendKey(date, String(params[1]));
      if (sends.has(key)) return [];
      sends.set(key, { state: "sending", segmentsSent: 0, receipts: null, attempts: 1 });
      return [{ state: "sending" }];
    }
    if (name === "read_send") {
      const send = sends.get(sendKey(date, String(params[1])));
      return send ? [{ state: send.state, segments_sent: send.segmentsSent, receipts: send.receipts, attempts: send.attempts }] : [];
    }
    if (name === "reclaim_failed_send") {
      const send = sends.get(sendKey(date, String(params[1])));
      if (!send || (send.state !== "failed" && send.state !== "partial") || send.attempts >= 2) return [];
      send.state = "sending";
      send.attempts += 1;
      return [{ state: "sending", segments_sent: send.segmentsSent }];
    }
    if (name === "finish_send") {
      const send = sends.get(sendKey(date, String(params[1])));
      const next = String(params[2]);
      if (!send || send.state !== "sending") return [];
      if (next !== "sent" && next !== "failed" && next !== "uncertain" && next !== "partial") return [];
      send.state = next;
      send.segmentsSent = Number(params[4] ?? send.segmentsSent);
      send.receipts = params[5] == null ? send.receipts : String(params[5]);
      return [{ state: next }];
    }
    throw new Error(`Unexpected query ${name}`);
  };
}
