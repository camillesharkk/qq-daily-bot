import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isRecord } from "@/lib/guard";

type StoredReport = {
  date: string;
  content: string;
  sent: boolean;
};

let memory: StoredReport | null = null;

function storePath(): string {
  return process.env.REPORT_STORE_PATH || join(tmpdir(), `qq-daily-bot-report-${process.pid}.json`);
}

function readStored(): StoredReport | null {
  if (memory) return memory;
  try {
    const parsed: unknown = JSON.parse(readFileSync(/* turbopackIgnore: true */ storePath(), "utf8"));
    if (!isRecord(parsed)) return null;
    if (typeof parsed.date !== "string" || typeof parsed.content !== "string" || typeof parsed.sent !== "boolean") {
      return null;
    }
    memory = { date: parsed.date, content: parsed.content, sent: parsed.sent };
    return memory;
  } catch {
    return null;
  }
}

function writeStored(report: StoredReport): void {
  memory = report;
  const path = storePath();
  mkdirSync(/* turbopackIgnore: true */ dirname(path), { recursive: true });
  writeFileSync(/* turbopackIgnore: true */ path, JSON.stringify(report));
}

export function readDaily(date: string): StoredReport | null {
  const report = readStored();
  if (!report || report.date !== date || report.content.trim() === "") return null;
  return report;
}

export function saveGenerated(date: string, content: string): void {
  const current = readStored();
  writeStored({
    date,
    content,
    sent: current?.date === date ? current.sent : false,
  });
}

export function markSent(date: string): void {
  const current = readStored();
  if (!current || current.date !== date) return;
  writeStored({ ...current, sent: true });
}

export function resetDailyStore(): void {
  memory = null;
  try {
    unlinkSync(/* turbopackIgnore: true */ storePath());
  } catch {
    // The store file is absent until the first report is saved.
  }
}
