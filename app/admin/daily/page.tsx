import { shanghaiDate } from "@/lib/date";
import { DailyEditor } from "./editor";

export const dynamic = "force-dynamic";

export default function AdminDailyPage() {
  return (
    <>
      <style>{`
        body { margin: 0; font-family: "Segoe UI", sans-serif; background: #f6f4ef; color: #1d1a16; }
        main { max-width: 760px; margin: 0 auto; padding: 32px 20px 64px; }
        h1 { font-size: 28px; margin-bottom: 8px; }
        p { line-height: 1.6; }
        label { display: block; margin: 16px 0; font-weight: 600; }
        input, textarea { display: block; width: 100%; margin-top: 6px; box-sizing: border-box; font: inherit; padding: 8px; }
        textarea { resize: vertical; }
        .actions { display: flex; flex-wrap: wrap; gap: 8px; }
        button { font: inherit; padding: 8px 12px; cursor: pointer; }
        pre { white-space: pre-wrap; background: #fff; border: 1px solid #ddd; padding: 12px; }
      `}</style>
      <DailyEditor defaultDate={shanghaiDate()} />
    </>
  );
}
