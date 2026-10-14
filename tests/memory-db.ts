import type { DbQuery } from "@/lib/db";

type Report = {
  content: string | null;
  state: "generating" | "ready";
  claimId: string | null;
  claimedAt: string | null;
};

type Send = { state: "sending" | "sent" | "failed" | "uncertain" };

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
      reports.set(date, { content: null, state: "generating", claimId: String(params[1]), claimedAt: String(params[2]) });
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
      reports.set(date, { content: String(params[1]), state: "ready", claimId: null, claimedAt: null });
      return [{ report_date: date }];
    }
    if (name === "read_report") {
      const report = reports.get(date);
      return report ? [{ content: report.content, state: report.state }] : [];
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
    if (name === "claim_send") {
      if (!reports.has(date)) throw new Error("insert or update on table daily_sends violates foreign key constraint");
      const key = sendKey(date, String(params[1]));
      if (sends.has(key)) return [];
      sends.set(key, { state: "sending" });
      return [{ state: "sending" }];
    }
    if (name === "read_send") {
      const send = sends.get(sendKey(date, String(params[1])));
      return send ? [{ state: send.state }] : [];
    }
    if (name === "reclaim_failed_send") {
      const send = sends.get(sendKey(date, String(params[1])));
      if (!send || send.state !== "failed") return [];
      send.state = "sending";
      return [{ state: "sending" }];
    }
    if (name === "finish_send") {
      const send = sends.get(sendKey(date, String(params[1])));
      const next = String(params[2]);
      if (!send || send.state !== "sending") return [];
      if (next !== "sent" && next !== "failed" && next !== "uncertain") return [];
      send.state = next;
      return [{ state: next }];
    }
    throw new Error(`Unexpected query ${name}`);
  };
}
