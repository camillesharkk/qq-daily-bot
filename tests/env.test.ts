import { afterEach, describe, expect, it } from "vitest";
import { qqApiBase, requireEnv } from "@/lib/env";

const KEYS = [
  "QQ_APP_ID",
  "QQ_APP_SECRET",
  "QQ_GROUP_OPENID",
  "QQ_API_BASE",
  "CRON_SECRET",
  "ADMIN_TOKEN",
  "OPENAI_API_KEY",
  "OPENAI_MODEL",
  "DAILY_MESSAGE",
  "REPORT_SOURCE_URL",
  "REPORT_SOURCE_TOKEN",
] as const;

function snapshotEnv(): () => void {
  const saved = new Map<string, string | undefined>();
  for (const key of KEYS) saved.set(key, process.env[key]);
  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

describe("env", () => {
  let restore: () => void;

  afterEach(() => {
    restore?.();
  });

  it("does not include secret values when a variable is missing", () => {
    restore = snapshotEnv();
    const marker = "sensitive-value-not-in-error";
    process.env.QQ_APP_SECRET = marker;
    delete process.env.QQ_APP_ID;

    let missingId = "";
    try {
      requireEnv("QQ_APP_ID");
    } catch (error) {
      missingId = error instanceof Error ? error.message : String(error);
    }
    expect(missingId).toContain("QQ_APP_ID");
    expect(missingId).not.toContain(marker);

    delete process.env.QQ_APP_SECRET;
    let missingSecret = "";
    try {
      requireEnv("QQ_APP_SECRET");
    } catch (error) {
      missingSecret = error instanceof Error ? error.message : String(error);
    }
    expect(missingSecret).toContain("Missing required environment variable: QQ_APP_SECRET");
    expect(missingSecret).not.toContain(marker);
  });

  it("defaults the QQ API base to the sandbox", () => {
    restore = snapshotEnv();
    delete process.env.QQ_API_BASE;
    expect(qqApiBase()).toBe("https://sandbox.api.sgroup.qq.com");
  });
});
