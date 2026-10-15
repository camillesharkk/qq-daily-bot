export type Holding = {
  symbol: string;
  exchange: string;
  name: string;
  status: "已核对" | "身份待核实";
  analyze: boolean;
};

export const MAPPING_NOTE = "SPCX 身份待核实，不纳入行业敞口、估值和买卖分析，也不把它写成未上市股票。";

export const REPORT_FAILED = "今天的日报没有生成完成，未完成内容不会发送。";

export const HOLDINGS: readonly Holding[] = [
  { symbol: "NDQ", exchange: "ASX", name: "BetaShares NASDAQ 100 ETF", status: "已核对", analyze: true },
  { symbol: "VAP", exchange: "ASX", name: "Vanguard Australian Property Securities Index ETF", status: "已核对", analyze: true },
  { symbol: "QQQ", exchange: "NASDAQ", name: "Invesco QQQ Trust", status: "已核对", analyze: true },
  { symbol: "MSFT", exchange: "NASDAQ", name: "微软 Microsoft", status: "已核对", analyze: true },
  { symbol: "NVDA", exchange: "NASDAQ", name: "英伟达 NVIDIA", status: "已核对", analyze: true },
  { symbol: "TSLA", exchange: "NASDAQ", name: "特斯拉 Tesla", status: "已核对", analyze: true },
  { symbol: "SMH", exchange: "NASDAQ", name: "VanEck Semiconductor ETF", status: "已核对", analyze: true },
  { symbol: "XOM", exchange: "NYSE", name: "埃克森美孚 Exxon Mobil", status: "已核对", analyze: true },
  { symbol: "SPCX", exchange: "待核实", name: "截图名称未能对应到可交易产品", status: "身份待核实", analyze: false },
];

export function holdingLines(): string {
  const watched = HOLDINGS.filter((item) => item.analyze).map(
    (item) => `${item.exchange}:${item.symbol} ${item.name}`,
  );
  return [
    ...watched,
    "SPCX：身份待核实。不要把它写成 SpaceX 或任何已确认的股票，不要分析它的行业、估值或买卖。",
  ].join("\n");
}
