export const DEFAULT_SEGMENT_LIMIT = 1400;

function lengthOf(text: string): number {
  return Array.from(text).length;
}

function hardSplit(text: string, limit: number): string[] {
  const units = Array.from(text);
  const parts: string[] = [];
  for (let index = 0; index < units.length; index += limit) {
    const piece = units.slice(index, index + limit).join("").trim();
    if (piece) parts.push(piece);
  }
  return parts;
}

function splitParagraph(paragraph: string, limit: number): string[] {
  if (lengthOf(paragraph) <= limit) return [paragraph];
  const sentences = paragraph
    .split(/(?<=[。！？；!?])/u)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  if (sentences.length <= 1) return hardSplit(paragraph, limit);

  const pieces: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    if (lengthOf(sentence) > limit) {
      if (current) pieces.push(current);
      current = "";
      pieces.push(...hardSplit(sentence, limit));
      continue;
    }
    const next = current ? `${current}${sentence}` : sentence;
    if (lengthOf(next) <= limit) {
      current = next;
    } else {
      if (current) pieces.push(current);
      current = sentence;
    }
  }
  if (current) pieces.push(current);
  return pieces;
}

function pack(text: string, limit: number): string[] {
  const paragraphs = text
    .split(/\n+/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  const parts: string[] = [];
  let current = "";

  for (const paragraph of paragraphs) {
    for (const piece of splitParagraph(paragraph, limit)) {
      const next = current ? `${current}\n${piece}` : piece;
      if (current && lengthOf(next) > limit) {
        parts.push(current);
        current = piece;
      } else {
        current = next;
      }
    }
  }
  if (current.trim()) parts.push(current);
  return parts.filter((part) => part.trim().length > 0);
}

function header(index: number, total: number): string {
  return `第 ${index}/${total} 段\n`;
}

export function splitForQq(text: string, limit = DEFAULT_SEGMENT_LIMIT): string[] {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];
  if (limit < 16) throw new Error("Segment limit is too small");
  if (lengthOf(normalized) <= limit) return [normalized];

  let parts = pack(normalized, limit);
  if (parts.length <= 1) return parts;

  const budget = limit - lengthOf(header(parts.length, parts.length));
  parts = pack(normalized, budget);
  if (parts.length <= 1) return parts;

  const grown = lengthOf(header(parts.length, parts.length));
  if (limit - grown !== budget) {
    parts = pack(normalized, limit - grown);
  }
  if (parts.length <= 1) return parts;

  const titled = parts.map((part, index) => `${header(index + 1, parts.length)}${part}`.trim());
  const safe: string[] = [];
  for (const segment of titled) {
    if (!segment.trim()) continue;
    if (lengthOf(segment) <= limit) {
      safe.push(segment);
      continue;
    }
    safe.push(...hardSplit(segment, limit));
  }
  return safe.filter((segment) => segment.trim().length > 0 && lengthOf(segment) <= limit);
}

function sourceLabel(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./i, "");
    return host ? `（来源：${host}）` : "";
  } catch {
    return "";
  }
}

export function stripUrls(text: string): string {
  const withoutMarkdown = text.replace(
    /!?\[([^\]]*)\]\(\s*(https?:\/\/[^)\s]+)\s*\)/gi,
    (_match, title: string, url: string) => {
      const label = sourceLabel(url);
      const name = title.trim();
      if (name && label) return `${name}${label}`;
      return name || label;
    },
  );
  const withoutRaw = withoutMarkdown.replace(/https?:\/\/[^\s<>"']+/gi, (token) => {
    const matched = /^(https?:\/\/.*?)([)\]}>》」』，。；;,.!！?？、]*)$/iu.exec(token);
    const url = matched?.[1] ?? token;
    const trailing = matched?.[2] ?? "";
    return `${sourceLabel(url)}${trailing}`;
  });
  return withoutRaw.replace(/[ \t]{2,}/g, " ").trim();
}

export function toPlainText(text: string): string {
  return text
    .replace(/```[a-zA-Z0-9_-]*\n?([\s\S]*?)```/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/__([^_\n]+)__/g, "$1")
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "")
    .replace(/\*\*/g, "")
    .replace(/^[ \t]*[-*+][ \t]+/gm, "• ");
}

export function prepareQqMessages(content: string, limit = DEFAULT_SEGMENT_LIMIT): string[] {
  return splitForQq(stripUrls(toPlainText(content)), limit).filter((segment) => segment.trim().length > 0);
}
