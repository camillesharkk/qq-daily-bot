import { DailyStoreError, dbQuery } from "@/lib/db";

const CLAIM_STALE_MS = 3 * 60 * 1000;

const CLAIM_REPORT = `
/* claim_report */
INSERT INTO daily_reports (report_date, state, claim_id, claimed_at)
VALUES ($1, 'generating', $2, $3)
ON CONFLICT (report_date) DO NOTHING
RETURNING claim_id
`;

const TAKEOVER_REPORT = `
/* takeover_report */
UPDATE daily_reports
SET claim_id = $2, claimed_at = $3
WHERE report_date = $1
  AND state = 'generating'
  AND claimed_at < $4
RETURNING claim_id
`;

const SAVE_REPORT = `
/* save_report */
INSERT INTO daily_reports (report_date, content, state, claim_id, claimed_at)
VALUES ($1, $2, 'ready', NULL, NULL)
ON CONFLICT (report_date) DO UPDATE
SET content = EXCLUDED.content, state = 'ready', claim_id = NULL, claimed_at = NULL
RETURNING report_date
`;

const READ_REPORT = `
/* read_report */
SELECT content, state
FROM daily_reports
WHERE report_date = $1
`;

const COMMIT_REPORT = `
/* commit_report */
UPDATE daily_reports
SET content = $2, state = 'ready', claim_id = NULL
WHERE report_date = $1 AND claim_id = $3 AND state = 'generating'
RETURNING report_date
`;

const RELEASE_REPORT = `
/* release_report */
DELETE FROM daily_reports
WHERE report_date = $1 AND claim_id = $2 AND state = 'generating'
RETURNING report_date
`;

const CLAIM_SEND = `
/* claim_send */
INSERT INTO daily_sends (report_date, group_openid, state, updated_at)
VALUES ($1, $2, 'sending', $3)
ON CONFLICT (report_date, group_openid) DO NOTHING
RETURNING state
`;

const READ_SEND = `
/* read_send */
SELECT state
FROM daily_sends
WHERE report_date = $1 AND group_openid = $2
`;

const RECLAIM_FAILED_SEND = `
/* reclaim_failed_send */
UPDATE daily_sends
SET state = 'sending', updated_at = $3
WHERE report_date = $1 AND group_openid = $2 AND state = 'failed'
RETURNING state
`;

const FINISH_SEND = `
/* finish_send */
UPDATE daily_sends
SET state = $3, updated_at = $4
WHERE report_date = $1 AND group_openid = $2 AND state = 'sending'
RETURNING state
`;

export type PreparedReport =
  | { status: "ready"; content: string; generate: "created" | "reused" }
  | { status: "in_progress" };

export type SendClaim = "send" | "already_sent" | "in_progress" | "uncertain";

type ReportRow = { content: string | null; state: string };

function dateOnly(date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new DailyStoreError("Invalid report date");
  return date;
}

function groupId(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || /[\r\n]/.test(trimmed)) throw new DailyStoreError("Invalid group id");
  return trimmed;
}

async function rows(text: string, params: readonly unknown[]): Promise<Record<string, unknown>[]> {
  try {
    return await dbQuery(text, params);
  } catch (error) {
    if (error instanceof DailyStoreError) throw error;
    throw new DailyStoreError("Daily report database is unavailable");
  }
}

function reportFrom(row: Record<string, unknown> | undefined): ReportRow | null {
  if (!row || typeof row.state !== "string") return null;
  return { state: row.state, content: typeof row.content === "string" ? row.content : null };
}

async function readReport(date: string): Promise<ReportRow | null> {
  const found = await rows(READ_REPORT, [date]);
  return reportFrom(found[0]);
}

async function finishOwned(
  date: string,
  claimId: string,
  produce: () => Promise<string>,
  generate: "created" | "reused",
): Promise<PreparedReport> {
  try {
    const content = (await produce()).trim();
    if (!content) throw new DailyStoreError("Report content is empty");
    const saved = await rows(COMMIT_REPORT, [date, content, claimId]);
    if (saved.length === 0) throw new DailyStoreError("Lost the report claim before save");
    return { status: "ready", content, generate };
  } catch (error) {
    await rows(RELEASE_REPORT, [date, claimId]).catch(() => []);
    throw error;
  }
}

export async function prepareReport(date: string, produce: () => Promise<string>): Promise<PreparedReport> {
  const reportDate = dateOnly(date);
  const claimId = crypto.randomUUID();
  const now = new Date();
  const inserted = await rows(CLAIM_REPORT, [reportDate, claimId, now.toISOString()]);
  if (inserted.length > 0) return finishOwned(reportDate, claimId, produce, "created");

  const current = await readReport(reportDate);
  if (current?.state === "ready" && current.content) {
    return { status: "ready", content: current.content, generate: "reused" };
  }

  const staleBefore = new Date(now.getTime() - CLAIM_STALE_MS).toISOString();
  const taken = await rows(TAKEOVER_REPORT, [reportDate, claimId, now.toISOString(), staleBefore]);
  if (taken.length > 0) return finishOwned(reportDate, claimId, produce, "created");
  return { status: "in_progress" };
}

export async function saveReport(date: string, content: string): Promise<void> {
  const reportDate = dateOnly(date);
  const body = content.trim();
  if (!body) throw new DailyStoreError("Report content is empty");
  const saved = await rows(SAVE_REPORT, [reportDate, body]);
  if (saved.length === 0) throw new DailyStoreError("Report was not saved");
}

export async function readReadyReport(date: string): Promise<string | null> {
  const current = await readReport(dateOnly(date));
  if (!current || current.state !== "ready" || !current.content) return null;
  return current.content;
}

async function existingSend(date: string, group: string, now: string, nested: boolean): Promise<SendClaim> {
  const found = await rows(READ_SEND, [date, group]);
  const state = found[0] && typeof found[0].state === "string" ? found[0].state : "";
  if (state === "sent") return "already_sent";
  if (state === "uncertain") return "uncertain";
  if (state === "sending") return "in_progress";
  if (state === "failed" && !nested) {
    const won = await rows(RECLAIM_FAILED_SEND, [date, group, now]);
    if (won.length > 0) return "send";
    return existingSend(date, group, now, true);
  }
  if (state === "failed") return "in_progress";
  throw new DailyStoreError("Unknown send state");
}

export async function readSendState(date: string, groupOpenId: string): Promise<string | null> {
  const found = await rows(READ_SEND, [dateOnly(date), groupId(groupOpenId)]);
  const state = found[0] && typeof found[0].state === "string" ? found[0].state : "";
  return state || null;
}

export async function claimSend(date: string, groupOpenId: string): Promise<SendClaim> {
  const reportDate = dateOnly(date);
  const group = groupId(groupOpenId);
  const now = new Date().toISOString();
  const inserted = await rows(CLAIM_SEND, [reportDate, group, now]);
  if (inserted.length > 0) return "send";
  return existingSend(reportDate, group, now, false);
}

export async function finishSend(
  date: string,
  groupOpenId: string,
  outcome: "sent" | "failed" | "uncertain",
): Promise<void> {
  const saved = await rows(FINISH_SEND, [dateOnly(date), groupId(groupOpenId), outcome, new Date().toISOString()]);
  if (saved.length === 0) throw new DailyStoreError("Send status was not updated");
}
