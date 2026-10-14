import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claimSend, finishSend, saveReport } from "@/lib/daily-store";
import { useQueryForTests } from "@/lib/db";
import { createMemoryQuery } from "./memory-db";

describe("daily report claims", () => {
  beforeEach(() => {
    useQueryForTests(createMemoryQuery());
  });

  afterEach(() => {
    useQueryForTests(null);
  });

  it("lets only one concurrent claim send to the same group", async () => {
    await saveReport("2026-10-14", "同一份");
    const claims = await Promise.all([
      claimSend("2026-10-14", "group-a"),
      claimSend("2026-10-14", "group-a"),
    ]);
    expect(claims.filter((claim) => claim === "send")).toHaveLength(1);
    expect(claims).toContain("in_progress");
  });

  it("keeps an uncertain send from being claimed again and allows another group", async () => {
    await saveReport("2026-10-14", "同一份");
    expect(await claimSend("2026-10-14", "group-a")).toBe("send");
    await finishSend("2026-10-14", "group-a", "uncertain");
    expect(await claimSend("2026-10-14", "group-a")).toBe("uncertain");
    expect(await claimSend("2026-10-14", "group-b")).toBe("send");
  });
});
