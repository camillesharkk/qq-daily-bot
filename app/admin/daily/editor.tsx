"use client";

import { useState } from "react";

type Result = {
  ok?: boolean;
  error?: string;
  message?: string;
  status?: string;
  errCode?: string | null;
  sendState?: string | null;
  content?: string | null;
  segments?: string[];
  segmentCount?: number;
};

export function DailyEditor({ defaultDate }: { defaultDate: string }) {
  const [token, setToken] = useState("");
  const [date, setDate] = useState(defaultDate);
  const [content, setContent] = useState("");
  const [pending, setPending] = useState("");
  const [result, setResult] = useState<Result | null>(null);

  async function submit(action: "preview" | "save" | "send" | "status"): Promise<void> {
    setPending(action);
    setResult(null);
    try {
      const response = await fetch("/api/admin/daily", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token.trim()}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ action, date, content }),
      });
      const body: unknown = await response.json();
      const next = typeof body === "object" && body ? (body as Result) : { error: "invalid response" };
      if (action === "status" && typeof next.content === "string") setContent(next.content);
      setResult(next);
    } catch {
      setResult({ error: "请求没有完成" });
    } finally {
      setPending("");
    }
  }

  const segments = result?.segments ?? [];

  return (
    <main>
      <h1>日报管理</h1>
      <p>把 ChatGPT 里生成的日报原文粘贴到这里。保存后，群里 @机器人并发送“日报”会读到这份原文。本页不调用 OpenAI 或 DeepSeek，也不改写保存的正文。</p>
      <label>
        管理密钥
        <input
          type="password"
          autoComplete="off"
          value={token}
          onChange={(event) => setToken(event.target.value)}
        />
      </label>
      <label>
        报告日期（北京时间）
        <input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
      </label>
      <label>
        日报原文
        <textarea value={content} onChange={(event) => setContent(event.target.value)} rows={16} />
      </label>
      <div className="actions">
        <button type="button" disabled={pending !== ""} onClick={() => void submit("preview")}>
          预览将发到 QQ 的内容
        </button>
        <button type="button" disabled={pending !== ""} onClick={() => void submit("status")}>
          查看已保存
        </button>
        <button type="button" disabled={pending !== ""} onClick={() => void submit("save")}>
          保存
        </button>
        <button type="button" disabled={pending !== ""} onClick={() => void submit("send")}>
          保存并发送到已绑定群
        </button>
      </div>
      <p>主动发送需要已配置的绑定群，以及 QQ 允许机器人主动发群消息。若主动发送被拒绝，正文仍会保存，可以在群里被动读取。</p>
      {result ? (
        <section>
          <h2>结果</h2>
          {result.error ? <p>{result.error}</p> : null}
          {result.message ? <p>{result.message}</p> : null}
          {result.status ? <p>发送状态：{result.status}</p> : null}
          {result.sendState ? <p>该日该群已有发送状态：{result.sendState}</p> : null}
          {result.errCode ? <p>QQ 错误码：{result.errCode}</p> : null}
          {typeof result.segmentCount === "number" ? <p>实际发送分段：{result.segmentCount}</p> : null}
          {segments.map((segment, index) => (
            <pre key={`${index}-${segment.slice(0, 12)}`}>{segment}</pre>
          ))}
        </section>
      ) : null}
    </main>
  );
}
