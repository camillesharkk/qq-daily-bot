export type HoldingWatch = {
  label: string;
  weightPercent: number;
  watch: string;
  status: "未核实";
};

export const MAPPING_NOTE = "当前持仓映射为暂定，不代表已识别实际证券。";

export const HOLDINGS: readonly HoldingWatch[] = [
  { label: "地产", weightPercent: 24, watch: "澳洲房地产行业及REITs", status: "未核实" },
  { label: "纳指", weightPercent: 25, watch: "纳斯达克100指数", status: "未核实" },
  { label: "美纳指", weightPercent: 15, watch: "暂按纳斯达克综合指数", status: "未核实" },
  { label: "半导体", weightPercent: 12, watch: "全球半导体行业，重点美国芯片企业及全球供应链", status: "未核实" },
  { label: "英伟达", weightPercent: 10, watch: "对应公司动态", status: "未核实" },
  { label: "微软", weightPercent: 9, watch: "对应公司动态", status: "未核实" },
  { label: "特斯拉", weightPercent: 5, watch: "对应公司动态", status: "未核实" },
];

export function retrievalFailureReport(): string {
  const lines = HOLDINGS.map(
    (item) => `- ${item.label}（${item.weightPercent}%，${item.status}，关注范围：${item.watch}）：检索失败`,
  );
  return [
    "今日没有拿到可引用的检索结果，因此不能把以下内容当作最新新闻。",
    ...lines,
    "额外关注澳元兑美元，不假定任何产品有汇率对冲。",
    MAPPING_NOTE,
  ].join("\n");
}
