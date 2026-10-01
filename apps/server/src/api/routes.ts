import type { IncomingMessage, ServerResponse } from "node:http";
import {
  isInterval,
  type OpenPositionRequest,
  type SymbolOverview,
  type UpdateProtectionRequest,
} from "@signal-lab/shared";
import type { Analyzer } from "../analysis/analyzer";
import type { OpportunityScanner } from "../analysis/opportunities";
import { writeMarketReport } from "../analysis/writer";
import type { BacktestService } from "../backtest/service";
import { computeGuard } from "../trading/guard";
import { fetchKlines, type SymbolFilters } from "../binance/rest";
import type { Config } from "../config";
import type { LiveScorecard } from "../live/liveScorecard";
import type { MarketData } from "../market/marketData";
import type { SignalTracker } from "../scorecard/tracker";
import type { SignalEngine } from "../signals/engine";
import { TradingError, type Broker } from "../trading/types";

export interface ApiDeps {
  config: Config;
  market: MarketData;
  engine: SignalEngine;
  tracker: SignalTracker;
  broker: Broker;
  analyzer: Analyzer;
  opportunities: OpportunityScanner;
  backtests: BacktestService;
  live?: LiveScorecard;
  /** Binance coin kuralları (min. miktar / min. büyüklük) */
  filters?: () => Map<string, SymbolFilters>;
}

type Handler = (ctx: {
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
}) => Promise<unknown> | unknown;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function createApi(deps: ApiDeps) {
  const { config, market, engine, tracker, broker, analyzer, opportunities, backtests } = deps;
  const routes: Route[] = [];
  const route = (method: string, path: string, handler: Handler) => {
    const keys: string[] = [];
    const pattern = new RegExp(
      "^" + path.replace(/:(\w+)/g, (_, k: string) => (keys.push(k), "([^/]+)")) + "/?$",
    );
    routes.push({ method, pattern, keys, handler });
  };

  const requireSymbol = (raw: string | null): string => {
    const symbol = (raw ?? "").toUpperCase();
    if (!market.hasSymbol(symbol)) throw new HttpError(404, `Bilinmeyen sembol: ${raw}`);
    return symbol;
  };
  const requireInterval = (raw: string | null) => {
    if (!isInterval(raw)) throw new HttpError(400, `Geçersiz aralık: ${raw}`);
    return raw;
  };

  // ---- Genel ----
  route("GET", "/api/health", () => ({
    ok: true,
    binance: market.status,
    mode: broker.mode,
    time: Date.now(),
  }));

  route("GET", "/api/config", () => ({
    mode: broker.mode,
    symbols: market.symbols,
    signalIntervals: config.signalIntervals,
    primaryInterval: engine.primaryInterval,
    strategy: config.strategy,
    allowShort: config.strategy.allowShort,
    maxLeverage: config.trading.maxLeverage,
    consensusThreshold: config.consensus.threshold,
    aPlusOnly: config.selective.aPlusOnly,
    trackingStart: config.live.trackingStart,
    autoUniverse: config.symbols === null,
    // Coin başına Binance minimumları: istemci emir önizlemesinde uyarır
    minOrder: Object.fromEntries(
      [...(deps.filters?.() ?? new Map<string, SymbolFilters>()).values()].map((f) => [f.symbol, { minNotional: f.minNotional, minQty: f.minQty }]),
    ),
  }));

  // ---- Piyasa ----
  route("GET", "/api/symbols", (): SymbolOverview[] => {
    const tickers = new Map(market.getTickers().map((t) => [t.symbol, t]));
    return market.symbols.map((symbol) => ({
      symbol,
      ticker: tickers.get(symbol) ?? null,
      bias: engine.getBias(symbol) ?? null,
    }));
  });

  route("GET", "/api/klines", async ({ query }) => {
    const symbol = requireSymbol(query.get("symbol"));
    const interval = requireInterval(query.get("interval"));
    const limit = Math.min(Number(query.get("limit") ?? 500) || 500, 1500);
    const endTime = Number(query.get("endTime"));
    // endTime: grafikte geriye kaydırırken daha eski mumlar (önbelleğe alınmaz)
    if (endTime > 0) return fetchKlines(symbol, interval, limit, endTime);
    return market.getCandles(symbol, interval, limit);
  });

  route("GET", "/api/analysis", ({ query }) => {
    const symbol = requireSymbol(query.get("symbol"));
    const interval = requireInterval(query.get("interval") ?? engine.primaryInterval);
    return analyzer.analyze(symbol, interval);
  });

  route("GET", "/api/opportunities", () => opportunities.get());

  const guardStatus = async () => {
    const [state, trades] = await Promise.all([broker.getState(), broker.getTrades(5000)]);
    const btcDaily = engine.getView("BTCUSDT")?.btcDailyTrend ?? engine.getViews()[0]?.btcDailyTrend ?? null;
    return computeGuard(state, trades, config.guard, btcDaily);
  };

  route("GET", "/api/guard", () => guardStatus());

  route("GET", "/api/report", async () =>
    writeMarketReport(
      engine.getViews(),
      tracker.list({ limit: 500 }),
      await guardStatus(),
      market.getTickers().find((t) => t.symbol === "BTCUSDT"),
    ),
  );

  route("GET", "/api/consensus", ({ query }) => {
    const symbol = query.get("symbol");
    if (symbol) return engine.getView(requireSymbol(symbol)) ?? null;
    return engine.getViews().sort((a, b) => b.score - a.score);
  });

  route("GET", "/api/backtest", () => backtests.summary());

  // Grafikte göstermek için bir coinin geçmiş AL sinyalleri (backtest ile aynı kurallar)
  route("GET", "/api/history-signals", ({ query }) => backtests.historyFor(requireSymbol(query.get("symbol"))));

  // ---- Sinyaller ----
  route("GET", "/api/signals", ({ query }) =>
    tracker.list({
      symbol: query.get("symbol")?.toUpperCase() || undefined,
      interval: query.get("interval") || undefined,
      status: query.get("status") || undefined,
      limit: Math.min(Number(query.get("limit") ?? 200) || 200, 2000),
    }),
  );

  route("GET", "/api/scorecard", () => tracker.scorecard());

  // Canlı karne: izleme başlangıcından bu yana A+ kâğıt işlemler vs BTC / sepet al-tut
  route("GET", "/api/live", () => {
    if (!deps.live) throw new HttpError(503, "Canlı karne hazır değil");
    const start = deps.live.trackingStart;
    const open = tracker
      .list({ status: "OPEN", limit: 3000 })
      .filter((s) => s.kind === "consensus" && s.quality === "A+" && s.createdAt >= start && (s.entryLimit == null || s.fillPrice != null)).length;
    return deps.live.report(open);
  });

  // ---- Hesap / işlemler ----
  route("GET", "/api/account", () => broker.getState());
  route("GET", "/api/trades", ({ query }) => broker.getTrades(Number(query.get("limit") ?? 200) || 200));
  route("GET", "/api/equity", () => broker.getEquityHistory());

  route("POST", "/api/positions", async ({ body }) => {
    const b = (body ?? {}) as Partial<OpenPositionRequest>;
    const req: OpenPositionRequest = {
      symbol: requireSymbol(String(b.symbol ?? "")),
      side: b.side as OpenPositionRequest["side"],
      type: (b.type ?? "MARKET") as OpenPositionRequest["type"],
      margin: Number(b.margin),
      leverage: Number(b.leverage),
      limitPrice: b.limitPrice != null ? Number(b.limitPrice) : undefined,
      stopLoss: optionalNumber(b.stopLoss),
      takeProfit: optionalNumber(b.takeProfit),
      signalId: b.signalId ?? null,
      breakevenAtR: optionalNumber(b.breakevenAtR),
      expiresAt: optionalNumber(b.expiresAt),
      cancelIfPriceReaches: optionalNumber(b.cancelIfPriceReaches),
      maxHoldMs: optionalNumber(b.maxHoldMs),
    };
    // Tek tık (guarded) emirlerde risk kalkanı sunucu tarafında da uygulanır
    if ((body as { guarded?: boolean } | null)?.guarded) {
      const guard = await guardStatus();
      if (!guard.canTrade) throw new HttpError(400, `Risk kalkanı: ${guard.reasons.join("; ")}`);
    }
    return broker.openPosition(req);
  });

  // Tüm pozisyonları (ya da bir sembolünkileri) tek tıkla piyasa fiyatından kapatır
  route("POST", "/api/positions/close-all", async ({ body }) => {
    const symbol = (body as { symbol?: string } | null)?.symbol?.toUpperCase();
    const { positions } = await broker.getState();
    const targets = positions.filter((p) => !symbol || p.symbol === symbol);
    let realizedPnl = 0;
    const errors: string[] = [];
    for (const p of targets) {
      try {
        const trade = await broker.closePosition(p.id, 100);
        realizedPnl += trade?.realizedPnl ?? p.unrealizedPnl;
      } catch (err) {
        errors.push(`${p.symbol}: ${(err as Error).message}`);
      }
    }
    return { closed: targets.length - errors.length, realizedPnl, errors };
  });

  route("POST", "/api/positions/:id/close", ({ params, body }) => {
    const percent = Number((body as { percent?: number } | null)?.percent ?? 100);
    return broker.closePosition(decodeURIComponent(params.id), percent);
  });

  route("PATCH", "/api/positions/:id", ({ params, body }) => {
    const b = (body ?? {}) as Partial<UpdateProtectionRequest>;
    return broker.updateProtection(decodeURIComponent(params.id), {
      stopLoss: optionalNumber(b.stopLoss),
      takeProfit: optionalNumber(b.takeProfit),
    });
  });

  route("DELETE", "/api/orders/:id", async ({ params }) => {
    await broker.cancelOrder(decodeURIComponent(params.id));
    return { ok: true };
  });

  route("POST", "/api/account/reset", async ({ body }) => {
    if (!broker.reset) throw new HttpError(400, "Sıfırlama sadece kâğıt hesapta kullanılabilir");
    const balance = (body as { balance?: number } | null)?.balance;
    await broker.reset(balance != null ? Number(balance) : undefined);
    return broker.getState();
  });

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader("Access-Control-Allow-Origin", config.corsOrigin);
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }

    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      const match = findRoute(routes, req.method ?? "GET", url.pathname);
      if (!match) throw new HttpError(404, "Bulunamadı");
      const body = req.method === "GET" ? null : await readBody(req);
      const result = await match.route.handler({ params: match.params, query: url.searchParams, body });
      send(res, 200, result ?? null);
    } catch (err) {
      if (err instanceof HttpError || err instanceof TradingError) {
        send(res, err.status, { error: err.message });
      } else {
        console.error("[api]", req.method, url.pathname, err);
        send(res, 500, { error: "Sunucu hatası" });
      }
    }
  };
}

function findRoute(routes: Route[], method: string, path: string) {
  for (const route of routes) {
    if (route.method !== method) continue;
    const m = route.pattern.exec(path);
    if (!m) continue;
    const params: Record<string, string> = {};
    route.keys.forEach((k, i) => (params[k] = m[i + 1]));
    return { route, params };
  }
  return null;
}

function optionalNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new HttpError(400, `Geçersiz sayı: ${String(v)}`);
  return n;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 1_000_000) throw new HttpError(413, "İstek çok büyük");
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Geçersiz JSON");
  }
}

function send(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}
