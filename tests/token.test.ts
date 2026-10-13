import { afterEach, describe, expect, it, vi } from "vitest";
import { clearAccessTokenCache, getAccessToken } from "@/lib/qq/token";

const ENV_KEYS = ["QQ_APP_ID", "QQ_APP_SECRET"] as const;

describe("qq access token", () => {
  const originalFetch = globalThis.fetch;
  const saved = new Map<string, string | undefined>();

  afterEach(() => {
    globalThis.fetch = originalFetch;
    clearAccessTokenCache();
    for (const key of ENV_KEYS) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    saved.clear();
    vi.restoreAllMocks();
  });

  function useFakeCredentials(): void {
    for (const key of ENV_KEYS) saved.set(key, process.env[key]);
    process.env.QQ_APP_ID = "test-app-id";
    process.env.QQ_APP_SECRET = "test-app-secret";
  }

  it("refreshes the cached token 60 seconds before expiry", async () => {
    useFakeCredentials();
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return Response.json({ access_token: "test-token", expires_in: "120" });
    }) as typeof fetch;

    await getAccessToken(1_000);
    await getAccessToken(50_000);
    expect(calls).toBe(1);
    await getAccessToken(61_000);
    expect(calls).toBe(2);
  });

  it("throws an error that does not include the app secret or token", async () => {
    useFakeCredentials();
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ message: "test-app-secret leaked", access_token: "nope" }), {
        status: 500,
      })) as typeof fetch;

    await expect(getAccessToken()).rejects.toThrow(/HTTP 500/);
    await expect(getAccessToken()).rejects.toThrow(/^(?!.*test-app-secret).*$/);
    expect(logs.join("\n")).not.toContain("test-app-secret");
    expect(logs.join("\n")).not.toContain("test-token");
  });
});
