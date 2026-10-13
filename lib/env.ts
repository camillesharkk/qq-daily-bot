export function requireEnv(name: string): string {
  const value = process.env[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function optionalEnv(name: string): string | undefined {
  const value = process.env[name];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

export function qqApiBase(): string {
  const configured = optionalEnv("QQ_API_BASE") ?? "https://sandbox.api.sgroup.qq.com";
  return configured.replace(/\/+$/, "");
}
