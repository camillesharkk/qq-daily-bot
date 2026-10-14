import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { DELETE, GET, POST } from "@/app/api/mcp/route";
import { POST as token } from "@/app/oauth/token/route";
import { useQueryForTests } from "@/lib/db";
import { authorizationCode, MCP_RESOURCE, PUBLIC_ORIGIN, verifyAccessToken } from "@/lib/oauth";
import { createMemoryQuery } from "./memory-db";

describe("mcp handshake", () => {
  const saved = new Map<string, string | undefined>();
  const seen: string[] = [];
  let protocol = "";
  let server: Server | null = null;

  beforeEach(() => {
    for (const key of ["ADMIN_TOKEN", "QQ_GROUP_OPENID", "DATABASE_URL"]) {
      saved.set(key, process.env[key]);
    }
    seen.length = 0;
    protocol = "";
    useQueryForTests(createMemoryQuery());
    process.env.ADMIN_TOKEN = "test-admin-token";
    delete process.env.QQ_GROUP_OPENID;
    delete process.env.DATABASE_URL;
  });

  afterEach(async () => {
    useQueryForTests(null);
    if (server) {
      await new Promise<void>((resolve, reject) => server?.close((error) => error ? reject(error) : resolve()));
      server = null;
    }
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    saved.clear();
  });

  async function listen(): Promise<string> {
    server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const raw = Buffer.concat(chunks).toString("utf8");
      if (req.method === "POST" && raw) {
        const message = JSON.parse(raw) as { method?: string };
        if (message.method) seen.push(message.method);
      }
      const address = server?.address();
      const port = address && typeof address === "object" ? address.port : 0;
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (value === undefined || ["host", "connection", "content-length", "transfer-encoding"].includes(key)) continue;
        headers.set(key, Array.isArray(value) ? value.join(", ") : value);
      }
      const request = new Request(`http://127.0.0.1:${port}${req.url ?? "/"}`, {
        method: req.method,
        headers,
        body: req.method === "GET" || req.method === "HEAD" ? undefined : Buffer.concat(chunks),
      });
      const response = req.method === "GET" ? GET() : req.method === "DELETE" ? DELETE() : await POST(request);
      res.statusCode = response.status;
      response.headers.forEach((value, key) => {
        res.setHeader(key, value);
      });
      const bytes = Buffer.from(await response.arrayBuffer());
      if (raw.includes("\"initialize\"")) {
        const match = /"protocolVersion":"([^"]+)"/.exec(bytes.toString("utf8"));
        if (match?.[1]) protocol = match[1];
      }
      res.end(bytes);
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = address && typeof address === "object" ? address.port : 0;
    return `http://127.0.0.1:${port}/api/mcp`;
  }

  async function handshake(url: string): Promise<{ names: string[]; saveDescription: string }> {
    const client = new Client({ name: "qq-daily-bot-handshake", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(url));
    await client.connect(transport);
    const listed = await client.listTools();
    expect(client.getServerVersion()?.name).toBe("qq-daily-bot");
    const save = listed.tools.find((tool) => tool.name === "save_daily_report");
    const names = listed.tools.map((tool) => tool.name);
    const saveDescription = save?.description ?? "";
    expect(save?.inputSchema.type).toBe("object");
    expect(save?.annotations?.readOnlyHint).toBe(false);
    expect(save?.annotations?.openWorldHint).toBe(true);
    await client.close();
    return { names, saveDescription };
  }

  it("completes initialize, initialized, and tools/list without calling save", async () => {
    const url = await listen();
    const first = await handshake(url);
    const second = await handshake(url);
    expect(protocol).toBe("2025-11-25");
    expect(seen).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
      "initialize",
      "notifications/initialized",
      "tools/list",
    ]);
    expect(first.names).toEqual(second.names);
    expect(second.names).toEqual(["connection_status", "read_daily_report", "save_daily_report"]);
    expect(second.saveDescription).toContain("QQ");
    expect(second.saveDescription).toContain("主动发送");
    expect(GET().status).toBe(405);

    const denied = await POST(new Request(MCP_RESOURCE, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "save_daily_report", arguments: { date: "2026-10-14", content: "不要发送" } },
      }),
    }));
    expect(denied.status).toBe(401);

    const invalid = await POST(new Request(MCP_RESOURCE, {
      method: "POST",
      headers: {
        authorization: "Bearer invalid",
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 8, method: "tools/list" }),
    }));
    expect(invalid.status).toBe(401);

    const verifier = "verifier";
    const code = authorizationCode({
      clientId: "https://chatgpt.com/oauth/client.json",
      redirectUri: "https://chatgpt.com/connector_platform_oauth_redirect",
      challenge: createHash("sha256").update(verifier).digest("base64url"),
      resource: MCP_RESOURCE,
    });
    const exchanged = await token(new Request(`${PUBLIC_ORIGIN}/oauth/token`, {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        client_id: "https://chatgpt.com/oauth/client.json",
        redirect_uri: "https://chatgpt.com/connector_platform_oauth_redirect",
        resource: MCP_RESOURCE,
      }),
    }));
    const issued = await exchanged.json() as { access_token: string; refresh_token: string };
    const carried = JSON.parse(JSON.stringify({ access: issued.access_token })).access as string;
    expect(verifyAccessToken(`Bearer ${carried}`)).toBe(true);
    const refreshed = await token(new Request(`${PUBLIC_ORIGIN}/oauth/token`, {
      method: "POST",
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: issued.refresh_token, resource: MCP_RESOURCE }),
    }));
    const next = await refreshed.json() as { access_token: string };
    expect(verifyAccessToken(`Bearer ${next.access_token}`)).toBe(true);
  });
});
