import { isRecord } from "@/lib/guard";
import { requireEnv } from "@/lib/env";

const TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken";
const EXPIRY_SKEW_MS = 60_000;
const TIMEOUT_MS = 10_000;

type CachedToken = {
  token: string;
  expiresAt: number;
};

let cache: CachedToken | null = null;

export function clearAccessTokenCache(): void {
  cache = null;
}

export async function getAccessToken(now = Date.now()): Promise<string> {
  if (cache && now < cache.expiresAt - EXPIRY_SKEW_MS) {
    return cache.token;
  }

  const appId = requireEnv("QQ_APP_ID");
  const clientSecret = requireEnv("QQ_APP_SECRET");
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ appId, clientSecret }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Failed to get QQ access token: HTTP ${response.status}`);
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    throw new Error("Failed to get QQ access token: invalid response");
  }

  if (!isRecord(parsed) || typeof parsed.access_token !== "string" || parsed.access_token.trim() === "") {
    throw new Error("Failed to get QQ access token: missing access_token");
  }

  const expiresIn = typeof parsed.expires_in === "number" ? parsed.expires_in : Number(parsed.expires_in);
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new Error("Failed to get QQ access token: invalid expires_in");
  }

  const token = parsed.access_token;
  cache = { token, expiresAt: now + expiresIn * 1000 };
  return token;
}
