export const BIND_REPLY = "机器人连接成功，已识别当前群聊。";
export const HELLO_REPLY = "你好，已收到你的消息，群消息接收和回复测试成功。";
export const EMPTY_REPLY = "我在，请告诉我你的问题。";
export const DAILY_MISSING =
  "今天的日报尚未生成。生成完成后，北京时间 9 点这一小时会发送；也可以发送“日报”或“今日日报”查看。本次不会重新生成。";
export const DAILY_FAILED = "今天的日报没有生成完成，未完成内容不会发送。发送“今日日报”只能读到已经生成完成的正文。";
export const DAILY_PENDING = "今天的日报还在生成。生成完成后发送“日报”或“今日日报”即可查看。本次不会重新生成。";

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
  | { branch: "reply_daily" }
  | { branch: "reply_qa"; useReport: boolean };

export function planReply(content: string): ReplyPlan {
  const compact = content.replace(/[\s\u200b\u200c\u200d\ufeff]/g, "");
  if (compact.includes("绑定日报") || compact.includes("测试")) {
    return { branch: "reply_bind", text: BIND_REPLY };
  }
  const command = compact.replace(/[！!。.?？~～,，]/g, "");
  if (command === "日报" || command === "今日日报") return { branch: "reply_daily" };
  if (!compact) return { branch: "reply_empty", text: EMPTY_REPLY };
  const greeting = command.toLowerCase();
  if (GREETINGS.has(greeting)) return { branch: "reply_hello", text: HELLO_REPLY };
  return { branch: "reply_qa", useReport: compact.includes("日报") };
}
