import { describe, expect, it } from "vitest";
import { prepareQqMessages, splitForQq, stripUrls } from "@/lib/text";

describe("qq text", () => {
  it("does not emit empty segments and keeps each segment within the limit", () => {
    const text = Array.from({ length: 8 }, (_, index) => `段落${index}${"字".repeat(40)}`).join("\n\n");
    const parts = splitForQq(text, 50);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((part) => part.trim().length > 0)).toBe(true);
    expect(parts.every((part) => Array.from(part).length <= 50)).toBe(true);
    expect(parts[0]).toMatch(/^第 1\/\d+ 段/);
    expect(parts.at(-1)).toMatch(new RegExp(`^第 ${parts.length}/${parts.length} 段`));
  });

  it("splits one long paragraph without empty pieces", () => {
    const parts = splitForQq("甲".repeat(100), 30);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.join("").replace(/第 \d+\/\d+ 段/g, "")).toContain("甲");
    expect(parts.every((part) => part.trim().length > 0 && Array.from(part).length <= 30)).toBe(true);
  });

  it("keeps a short message as a single segment", () => {
    expect(splitForQq("今天只学一个名词。")).toEqual(["今天只学一个名词。"]);
  });

  it("replaces http links with a plain source name", () => {
    const stripped = stripUrls("详情见 https://news.example.com/a/b 和 [财报](https://ir.example.com/x)。");
    expect(stripped).not.toMatch(/https?:\/\//);
    expect(stripped).toContain("news.example.com");
    expect(stripped).toContain("财报");
    expect(stripped).toContain("ir.example.com");
  });

  it("sends group replies as plain text", () => {
    expect(prepareQqMessages("**不能联网**，没有`实时行情`。\n# 标题\n- 第一条")).toEqual([
      "不能联网，没有实时行情。\n标题\n• 第一条",
    ]);
  });
});
