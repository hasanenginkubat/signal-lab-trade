import type {
  AccountState,
  BacktestSummary,
  ConsensusView,
  GuardStatus,
  HistorySignal,
  LiveReport,
  MarketReport,
  Opportunity,
  TechnicalAnalysis,
  Candle,
  EquityPoint,
  Interval,
  OpenPositionRequest,
  PendingOrder,
  Position,
  Scorecard,
  Signal,
  SymbolOverview,
  Trade,
  UpdateProtectionRequest,
} from "@signal-lab/shared";

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? `${API_URL.replace(/^http/, "ws")}/ws`;

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...init?.headers },
      cache: "no-store",
    });
  } catch {
    throw new ApiError("Sunucuya ulaşılamıyor. API çalışıyor mu?", 0);
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError((body as { error?: string } | null)?.error ?? `HTTP ${res.status}`, res.status);
  return body as T;
}

const qs = (params: Record<string, string | number | undefined>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") s.set(k, String(v));
  return s.toString();
};

export interface ServerConfig {
  mode: "paper" | "binance";
  symbols: string[];
  signalIntervals: Interval[];
  primaryInterval: Interval;
  strategy: Record<string, number | boolean>;
  autoUniverse?: boolean;
  allowShort?: boolean;
  maxLeverage?: number;
  consensusThreshold?: number;
  /** Seçici mod varsayılanı (sadece A+) */
  aPlusOnly?: boolean;
  trackingStart?: number;
  minOrder?: Record<string, { minNotional: number; minQty: number }>;
}

export const api = {
  config: () => request<ServerConfig>("/api/config"),
  symbols: () => request<SymbolOverview[]>("/api/symbols"),
  klines: (symbol: string, interval: Interval, limit = 500, endTime?: number) =>
    request<Candle[]>(`/api/klines?${qs({ symbol, interval, limit, endTime })}`),
  signals: (p: { symbol?: string; interval?: string; status?: string; limit?: number } = {}) =>
    request<Signal[]>(`/api/signals?${qs(p)}`),
  scorecard: () => request<Scorecard>("/api/scorecard"),
  account: () => request<AccountState>("/api/account"),
  trades: (limit = 200) => request<Trade[]>(`/api/trades?limit=${limit}`),
  equity: () => request<EquityPoint[]>("/api/equity"),
  openPosition: (req: OpenPositionRequest, guarded = false) =>
    request<Position | PendingOrder>("/api/positions", { method: "POST", body: JSON.stringify({ ...req, guarded }) }),
  closePosition: (id: string, percent = 100) =>
    request<Trade | null>(`/api/positions/${encodeURIComponent(id)}/close`, {
      method: "POST",
      body: JSON.stringify({ percent }),
    }),
  updateProtection: (id: string, req: UpdateProtectionRequest) =>
    request<Position>(`/api/positions/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(req) }),
  cancelOrder: (id: string) => request<{ ok: true }>(`/api/orders/${encodeURIComponent(id)}`, { method: "DELETE" }),
  analysis: (symbol: string, interval: Interval) =>
    request<TechnicalAnalysis>(`/api/analysis?${qs({ symbol, interval })}`),
  opportunities: () => request<Opportunity[]>("/api/opportunities"),
  consensusAll: () => request<ConsensusView[]>("/api/consensus"),
  guard: () => request<GuardStatus>("/api/guard"),
  historySignals: (symbol: string) => request<HistorySignal[]>(`/api/history-signals?symbol=${encodeURIComponent(symbol)}`),
  report: () => request<MarketReport>("/api/report"),
  backtest: () => request<BacktestSummary>("/api/backtest"),
  live: () => request<LiveReport>("/api/live"),
  closeAll: (symbol?: string) =>
    request<{ closed: number; realizedPnl: number; errors: string[] }>("/api/positions/close-all", {
      method: "POST",
      body: JSON.stringify({ symbol }),
    }),
  resetAccount: (balance?: number) =>
    request<AccountState>("/api/account/reset", { method: "POST", body: JSON.stringify({ balance }) }),
};
