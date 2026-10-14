import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { optionalEnv } from "@/lib/env";

export const PUBLIC_ORIGIN = "https://bot.arizonanotaryprep.com";
export const MCP_RESOURCE = `${PUBLIC_ORIGIN}/api/mcp`;
const CODE_TTL_MS = 5 * 60 * 1000;
const ACCESS_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const REFRESH_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const CLIENT_ID = /^https:\/\/chatgpt\.com\/oauth\/(?:client\.json|[^/]+\/client\.json)$/;

type TokenPayload = {
  typ: "code" | "access" | "refresh";
  exp: number;
  aud?: string;
  clientId?: string;
  redirectUri?: string;
  challenge?: string;
};

export type IssuedTokens = {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
};

function secret(): string {
  const value = optionalEnv("ADMIN_TOKEN");
  if (!value) throw new Error("ADMIN_TOKEN is not configured");
  return value;
}

function sign(payload: TokenPayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mac = createHmac("sha256", secret()).update(body).digest("base64url");
  return `${body}.${mac}`;
}

function read(token: string): TokenPayload | null {
  const [body, mac] = token.split(".");
  if (!body || !mac) return null;
  const expected = createHmac("sha256", secret()).update(body).digest("base64url");
  const given = Buffer.from(mac);
  const actual = Buffer.from(expected);
  if (given.length !== actual.length || !timingSafeEqual(given, actual)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as TokenPayload;
    if (typeof payload.exp !== "number" || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export function allowedResource(value: string): boolean {
  return value === PUBLIC_ORIGIN || value === MCP_RESOURCE;
}

export function authorizationCode(input: {
  clientId: string;
  redirectUri: string;
  challenge: string;
  resource: string;
}): string {
  return sign({
    typ: "code",
    aud: input.resource,
    exp: Date.now() + CODE_TTL_MS,
    clientId: input.clientId,
    redirectUri: input.redirectUri,
    challenge: input.challenge,
  });
}

export function accessToken(audience: string = MCP_RESOURCE): string {
  return sign({ typ: "access", aud: audience, exp: Date.now() + ACCESS_TTL_MS });
}

function issueTokens(audience: string): IssuedTokens {
  return {
    accessToken: accessToken(audience),
    refreshToken: sign({ typ: "refresh", aud: audience, exp: Date.now() + REFRESH_TTL_MS }),
    expiresIn: ACCESS_TTL_MS / 1000,
  };
}

export function verifyAccessToken(header: string | null): boolean {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header ?? "");
  const token = match?.[1];
  if (!token) return false;
  const payload = read(token);
  return payload?.typ === "access" && typeof payload.aud === "string" && allowedResource(payload.aud);
}

export function exchangeCode(input: {
  code: string;
  verifier: string;
  clientId: string;
  redirectUri: string;
  resource: string;
}): IssuedTokens | null {
  if (!allowedResource(input.resource)) return null;
  const payload = read(input.code);
  if (!payload || payload.typ !== "code") return null;
  if (payload.clientId !== input.clientId || payload.redirectUri !== input.redirectUri) return null;
  if (payload.aud && payload.aud !== input.resource) return null;
  const hashed = createHash("sha256").update(input.verifier).digest("base64url");
  if (hashed !== payload.challenge) return null;
  return issueTokens(input.resource);
}

export function exchangeRefresh(token: string, resource: string | null): IssuedTokens | null {
  const payload = read(token);
  if (!payload || payload.typ !== "refresh" || !payload.aud || !allowedResource(payload.aud)) return null;
  if (resource && resource !== payload.aud) return null;
  return issueTokens(payload.aud);
}

export function clientIdAllowed(clientId: string): boolean {
  return CLIENT_ID.test(clientId);
}

export async function redirectAllowed(clientId: string, redirectUri: string): Promise<boolean> {
  if (!clientIdAllowed(clientId)) return false;
  const response = await fetch(clientId, { cache: "no-store", signal: AbortSignal.timeout(5000) });
  if (!response.ok) return false;
  const body: unknown = await response.json();
  if (!body || typeof body !== "object" || !Array.isArray((body as { redirect_uris?: unknown }).redirect_uris)) return false;
  return (body as { redirect_uris: unknown[] }).redirect_uris.includes(redirectUri);
}

export function metadata() {
  return {
    issuer: PUBLIC_ORIGIN,
    authorization_endpoint: `${PUBLIC_ORIGIN}/oauth/authorize`,
    token_endpoint: `${PUBLIC_ORIGIN}/oauth/token`,
    authorization_response_iss_parameter_supported: true,
    client_id_metadata_document_supported: true,
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: ["daily", "offline_access"],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
  };
}

export function protectedResourceMetadata() {
  return {
    resource: MCP_RESOURCE,
    authorization_servers: [PUBLIC_ORIGIN],
    scopes_supported: ["daily", "offline_access"],
    bearer_methods_supported: ["header"],
  };
}
