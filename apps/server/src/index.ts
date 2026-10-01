import { createServer } from "node:http";
import { Analyzer } from "./analysis/analyzer";
import { OpportunityScanner } from "./analysis/opportunities";
import { createApi } from "./api/routes";
import { roundTripCostPct } from "./backtest/backtest";
import { BacktestService } from "./backtest/service";
import { fetchKlines, fetchRange, fetchSymbolFilters, selectUniverse, type SymbolFilters } from "./binance/rest";
import { config } from "./config";
import { RealtimeHub } from "./db/realtime/hub";
import { LiveScorecard } from "./live/liveScorecard";
import { MarketData } from "./market/marketData";
import { SignalTracker } from "./scorecard/tracker";
import { SignalEngine } from "./signals/engine";
import { BinanceBroker } from "./trading/binanceBroker";
import { PaperBroker } from "./trading/paperBroker";
import type { Broker } from "./trading/types";

async function resolveSymbols(): Promise<string[]> {
  if (config.symbols) return config.symbols;
  try {
    const symbols = await selectUniverse(config.universe);
    console.info(`[signal-lab] gün içi trade evreni (hacim + hareket): ${symbols.join(", ")}`);
    return symbols;
  } catch (err) {
    console.error("[signal-lab] otomatik coin seçimi başarısız, varsayılan liste:", (err as Error).message);
    return config.fallbackSymbols;
  }
}

async function main(): Promise<void> {
  const symbols = await resolveSymbols();
  console.info(`[signal-lab] ${symbols.length} sembol, mod: ${config.trading.mode}, sinyal aralıkları: ${config.signalIntervals.join(", ")}`);

  const market = new MarketData(symbols, config.marketWsBase);
  const tracker = new SignalTracker(
    config.dataDir,
    config.strategy.expiryCandles,
    config.strategy.breakevenAtR,
    roundTripCostPct(config.costs),
  );
  // Canlı karne: kâğıt hesap (A+ sinyaller) vs BTC ve sepet al-tut
  const live = new LiveScorecard(
    config.dataDir,
    { trackingStart: config.live.trackingStart, riskPct: config.live.riskPct, quality: "A+" },
    {
      fetchCandles: (symbol, from, to) => fetchRange(symbol, "1h", from, to, 100),
      priceAt: async (symbol, time) => (await fetchKlines(symbol, "1m", 1, time))[0]?.open ?? null,
    },
  );
  const backtests = new BacktestService(market, config, config.dataDir);
  const engine = new SignalEngine(market, tracker, config, backtests);
  const analyzer = new Analyzer(market, engine, backtests, config);
  const opportunities = new OpportunityScanner(market, backtests);
  const broker: Broker =
    config.trading.mode === "binance"
      ? new BinanceBroker(market, { ...config.trading.binance, maxLeverage: config.trading.maxLeverage }, symbols, config.dataDir)
      : new PaperBroker(market, { ...config.trading.paper, maxLeverage: config.trading.maxLeverage }, config.dataDir);

  const server = createServer(
    createApi({ config, market, engine, tracker, broker, analyzer, opportunities, backtests, live, filters: () => filters }),
  );

  const hub = new RealtimeHub(server, (send) => {
    send({
      type: "hello",
      data: { mode: broker.mode, symbols: market.symbols, signalIntervals: config.signalIntervals, aPlusOnly: config.selective.aPlusOnly },
    });
    send({ type: "status", data: { binance: market.status } });
    send({ type: "tickers", data: market.getTickers() });
    send({ type: "opportunities", data: opportunities.get() });
    for (const v of engine.getViews()) send({ type: "consensus", data: v });
    void broker.getState().then((state) => send({ type: "account", data: state }));
  });

  // ---- olay bağlantıları ----
  market.on("candle", (c) => {
    hub.sendCandle(c);
    tracker.onCandle(c);
  });
  market.on("tickers", (t) => hub.queueTickers(t));
  market.on("status", (status) => hub.broadcast({ type: "status", data: { binance: status } }));

  engine.on("signal", (s) => hub.broadcast({ type: "signal", data: s }));
  engine.on("bias", (b) => hub.broadcast({ type: "bias", data: b }));
  engine.on("consensus", (v) => hub.broadcast({ type: "consensus", data: v }));
  engine.on("exitAlert", (a) => hub.broadcast({ type: "exitAlert", data: a }));
  tracker.on("updated", (s) => {
    hub.broadcast({ type: "signalUpdate", data: s });
    live.onSignal(s);
  });
  opportunities.on("updated", (list) => hub.broadcast({ type: "opportunities", data: list }));

  broker.on("trade", (t) => hub.broadcast({ type: "trade", data: t }));
  broker.on("notice", (n) => hub.broadcast({ type: "notice", data: n }));

  // Hesap durumunu en fazla saniyede bir yayınla
  let accountDirty = false;
  broker.on("changed", () => (accountDirty = true));
  const accountTimer = setInterval(() => {
    if (!accountDirty || hub.clientCount === 0) return;
    accountDirty = false;
    void broker
      .getState()
      .then((state) => hub.broadcast({ type: "account", data: state }))
      .catch((err) => console.error("[account]", (err as Error).message));
  }, 1000);

  await market.start();
  // Binance coin kuralları: kâğıt hesap da gerçek hesap gibi min. emir büyüklüğünü uygular
  let filters = new Map<string, SymbolFilters>();
  try {
    filters = await fetchSymbolFilters(symbols);
    if (broker instanceof PaperBroker) broker.setFilters(filters);
  } catch (err) {
    console.error("[signal-lab] coin kuralları alınamadı:", (err as Error).message);
  }
  await broker.start();
  // Sepet izleme başlangıcında sabitlenir (sonraki açılışlarda değişmez); kapalıyken kapanan sinyaller eklenir
  try {
    await live.init(market.symbols);
  } catch (err) {
    console.error("[live] başlatılamadı:", (err as Error).message);
  }
  for (const s of tracker.list({ limit: 3000 }).reverse()) live.onSignal(s);
  live.start();
  server.listen(config.port, () => {
    console.info(`[signal-lab] API http://localhost:${config.port}  •  WS ws://localhost:${config.port}/ws`);
  });
  await engine.start();
  opportunities.start();
  backtests.start();

  const shutdown = () => {
    console.info("[signal-lab] kapatılıyor…");
    clearInterval(accountTimer);
    market.stop();
    broker.stop();
    backtests.stop();
    opportunities.stop();
    tracker.flush();
    live.stop();
    hub.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[signal-lab] başlatılamadı:", err);
  process.exit(1);
});
