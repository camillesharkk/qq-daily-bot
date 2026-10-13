import type { ReactNode } from "react";

export const metadata = {
  title: "QQ Daily Bot",
  description: "QQ daily finance report bot",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
