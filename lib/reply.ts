export const BIND_REPLY = "机器人连接成功，已识别当前群聊。";
export const HELLO_REPLY = "你好，已收到你的消息，群消息接收和回复测试成功。";
export const EMPTY_REPLY = "我在，请告诉我你的问题。";

const GREETINGS = new Set([
  "你好",
  "您好",
  "嗨",
  "哈喽",
  "哈啰",
  "在吗",
  "早上好",
  "下午好",
  "晚上好",
  "早安",
  "晚安",
  "hello",
  "hi",
]);

export type ReplyPlan =
  | { branch: "reply_bind" | "reply_hello" | "reply_empty"; text: string }
  | { branch: "reply_qa" };

export function planReply(content: string): ReplyPlan {
  const compact = content.replace(/[\s\u200b\u200c\u200d\ufeff]/g, "");
  if (compact.includes("绑定日报") || compact.includes("测试")) {
    return { branch: "reply_bind", text: BIND_REPLY };
  }
  if (!compact) return { branch: "reply_empty", text: EMPTY_REPLY };
  const greeting = compact.replace(/[！!。.?？~～,，]/g, "").toLowerCase();
  if (GREETINGS.has(greeting)) return { branch: "reply_hello", text: HELLO_REPLY };
  return { branch: "reply_qa" };
}
