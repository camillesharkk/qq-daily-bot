const SECRET_ENV_KEYS = [
  "QQ_APP_SECRET",
  "OPENAI_API_KEY",
  "REPORT_SOURCE_TOKEN",
  "CRON_SECRET",
  "ADMIN_TOKEN",
  "QQ_GROUP_OPENID",
] as const;

export function safeLogMessage(error: unknown): string {
  let message =
    error instanceof Error ? error.message : typeof error === "string" ? error : "unknown error";
  message = message.replace(/sk-[A-Za-z0-9_-]{8,}/g, "[redacted]");
  message = message.replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
  for (const key of SECRET_ENV_KEYS) {
    const value = process.env[key];
    if (value && value.length >= 8) {
      message = message.split(value).join("[redacted]");
    }
  }
  return message.slice(0, 500);
}
