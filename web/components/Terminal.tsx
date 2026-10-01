"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { INTERVAL_LABELS, INTERVALS, type HistorySignal, type Interval, type Signal } from "@signal-lab/shared";
import { api } from "@/lib/api";
import { baseAsset, fmtCompact, fmtPct, fmtPrice } from "@/lib/format";
import { clearFocus, useStore } from "@/lib/store";
import { AccountPanel } from "./AccountPanel";
import { AnalysisPanel, useAnalysis } from "./AnalysisPanel";
import { SignalAction } from "./SignalAction";
import { CandleChart, type IndicatorToggles } from "./CandleChart";
import { OrderPanel } from "./OrderPanel";
import { OrdersTable } from "./OrdersTable";
import { PositionsTable } from "./PositionsTable";
import { SignalFeed } from "./SignalFeed";
import { BiasBadge, SymbolList } from "./SymbolList";
import { TradeHistory } from "./TradeHistory";

type Tab = "analysis" | "positions" | "orders" | "history" | "signals";

const DEFAULT_TOGGLES: IndicatorToggles = { ema: true, bb: false, volume: true, rsi: true, macd: false, levels: true };
const TOGGLE_LABELS: [keyof IndicatorToggles, string][] = [
  ["levels", "Destek/Direnç"],
  ["ema", "EMA"],
  ["bb", "Bollinger"],
  ["volume", "Hacim"],
  ["rsi", "RSI"],
  ["macd", "MACD"],
];

function readPref<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch {
    return fallback;
  }
}

function writePref(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* gizli modda depolama kapalı olabilir */
  }
}

export function Terminal({ initialSymbol }: { initialSymbol: string }) {
  const [symbol, setSymbol] = useState(initialSymbol.toUpperCase());
  const [interval, setIntervalState] = useState<Interval>("1h");
  const [toggles, setToggles] = useState<IndicatorToggles>(DEFAULT_TOGGLES);
  const [tab, setTab] = useState<Tab>("analysis");
  const [signalScope, setSignalScope] = useState<"all" | "symbol">("all");
  const [historicSignals, setHistoricSignals] = useState<Signal[]>([]);
  const [backtestSignals, setBacktestSignals] = useState<HistorySignal[]>([]);
  const onlyAPlus = useStore((s) => s.settings.onlyAPlus);

  const symbols = useStore((s) => s.symbols);
  const ticker = useStore((s) => s.tickers[symbol]);
  const primary = useStore((s) => s.primaryInterval);
  const bias = useStore((s) => s.biases[`${symbol}:${interval}`] ?? s.biases[`${symbol}:${primary}`]);
  const account = useStore((s) => s.account);
  const liveSignals = useStore((s) => s.signals);

  // Tercihleri yükle (sunucu render'ı ile uyumsuzluk olmasın diye mount sonrası)
  useEffect(() => {
    const prefs = readPref("sl.prefs", { interval: "1h" as Interval });
    if (INTERVALS.includes(prefs.interval)) setIntervalState(prefs.interval);
    setToggles(readPref("sl.indicators", DEFAULT_TOGGLES));
  }, []);

  // Bilinmeyen sembolde ilk sembole geç
  useEffect(() => {
    if (symbols.length && !symbols.includes(symbol)) setSymbol(symbols[0]);
  }, [symbols, symbol]);

  const selectSymbol = useCallback((s: string) => {
    setSymbol(s);
    window.history.replaceState(null, "", `/${s}`);
  }, []);

  const changeInterval = (iv: Interval) => {
    setIntervalState(iv);
    writePref("sl.prefs", { interval: iv });
  };

  const toggle = (key: keyof IndicatorToggles) => {
    setToggles((t) => {
      const next = { ...t, [key]: !t[key] };
      writePref("sl.indicators", next);
      return next;
    });
  };

  // Grafik işaretleri için bu coinin canlı sistemde üretilmiş sinyalleri (tüm aralıklarda gösterilir)
  useEffect(() => {
    let cancelled = false;
    api
      .signals({ symbol, limit: 500 })
      .then((s) => !cancelled && setHistoricSignals(s))
      .catch(() => !cancelled && setHistoricSignals([]));
    return () => {
      cancelled = true;
    };
  }, [symbol]);

  // Geçmiş AL sinyalleri (her coin için backtest; 10 dakikada bir tazelenir)
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      api
        .historySignals(symbol)
        .then((h) => !cancelled && setBacktestSignals(h))
        .catch(() => !cancelled && setBacktestSignals([]));
    void load();
    const t = window.setInterval(load, 10 * 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, [symbol]);
  // Grafikte tüm AL sinyalleri gösterilir (A+ parlak, A soluk); seçici mod sadece bildirimleri etkiler
  const chartHistory = backtestSignals;

  const chartSignals = useMemo(() => {
    const map = new Map<string, Signal>();
    for (const s of historicSignals) map.set(s.id, s);
    for (const s of liveSignals) if (s.symbol === symbol) map.set(s.id, s);
    // Seçici modda sadece A+ (A kaliteler listede kalır ama grafiği kalabalıklaştırmaz)
    return [...map.values()].filter((s) => !onlyAPlus || s.kind !== "consensus" || s.quality === "A+");
  }, [historicSignals, liveSignals, symbol, onlyAPlus]);

  const analysis = useAnalysis(symbol, interval);
  const consensusView = useStore((s) => s.consensus[symbol]);
  const focus = useStore((s) => s.focusSymbol);
  useEffect(() => {
    if (!focus) return;
    selectSymbol(focus.symbol);
    clearFocus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);
  const positions = useMemo(() => (account?.positions ?? []).filter((p) => p.symbol === symbol), [account, symbol]);
  const orders = useMemo(() => (account?.orders ?? []).filter((o) => o.symbol === symbol), [account, symbol]);

  useEffect(() => {
    document.title = ticker ? `${fmtPrice(ticker.price)} ${baseAsset(symbol)} • Signal Lab` : "Signal Lab";
  }, [ticker, symbol]);

  const openSignalCount = liveSignals.filter((s) => s.status === "OPEN").length;

  return (
    <main className="terminal">
      <SymbolList selected={symbol} onSelect={selectSymbol} />

      <section className="panel area-chart">
        <div className="chart-toolbar">
          <div className="chart-symbol">
            <span className="sym">{baseAsset(symbol)}/USDT</span>
            <span className={`px num ${ticker && ticker.changePct >= 0 ? "up" : "down"}`}>{fmtPrice(ticker?.price)}</span>
            <span className={`num ${ticker && ticker.changePct >= 0 ? "up" : "down"}`} style={{ fontSize: 12 }}>
              {fmtPct(ticker?.changePct)}
            </span>
          </div>
          {ticker && (
            <div className="chart-stats num">
              <span>
                <b>24s Y</b>
                {fmtPrice(ticker.high)}
              </span>
              <span>
                <b>24s D</b>
                {fmtPrice(ticker.low)}
              </span>
              <span>
                <b>Hacim</b>
                {fmtCompact(ticker.quoteVolume)} USDT
              </span>
            </div>
          )}
          <BiasBadge bias={bias} />
          <span className="tb-sep" />
          {INTERVALS.map((iv) => (
            <button key={iv} className={`tb-btn ${iv === interval ? "active" : ""}`} onClick={() => changeInterval(iv)}>
              {INTERVAL_LABELS[iv]}
            </button>
          ))}
          <span className="tb-sep" />
          {TOGGLE_LABELS.map(([key, label]) => (
            <button key={key} className={`tb-btn ${toggles[key] ? "active" : ""}`} onClick={() => toggle(key)}>
              {label}
            </button>
          ))}
        </div>
        <CandleChart
          symbol={symbol}
          interval={interval}
          indicators={toggles}
          signals={chartSignals}
          positions={positions}
          orders={orders}
          levels={analysis?.symbol === symbol ? analysis.levels : []}
          sessionLevels={consensusView?.levels ?? null}
          historySignals={chartHistory}
        />
      </section>

      <section className="panel area-bottom">
        <div className="tabs" role="tablist">
          <button className={`tab ${tab === "analysis" ? "active" : ""}`} onClick={() => setTab("analysis")}>
            Teknik Analiz
          </button>
          <button className={`tab ${tab === "positions" ? "active" : ""}`} onClick={() => setTab("positions")}>
            Pozisyonlar <span className="count">{account?.positions.length ?? 0}</span>
          </button>
          <button className={`tab ${tab === "orders" ? "active" : ""}`} onClick={() => setTab("orders")}>
            Açık emirler <span className="count">{account?.orders.length ?? 0}</span>
          </button>
          <button className={`tab ${tab === "history" ? "active" : ""}`} onClick={() => setTab("history")}>
            İşlem geçmişi
          </button>
          <button className={`tab ${tab === "signals" ? "active" : ""}`} onClick={() => setTab("signals")}>
            Sinyaller <span className="count">{openSignalCount}</span>
          </button>
          {tab === "signals" && (
            <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 4 }}>
              <button className={`tb-btn ${signalScope === "all" ? "active" : ""}`} onClick={() => setSignalScope("all")}>
                Tümü
              </button>
              <button
                className={`tb-btn ${signalScope === "symbol" ? "active" : ""}`}
                onClick={() => setSignalScope("symbol")}
              >
                {baseAsset(symbol)}
              </button>
            </span>
          )}
        </div>
        <div className="panel-body">
          {tab === "analysis" && <AnalysisPanel analysis={analysis?.symbol === symbol ? analysis : null} />}
          {tab === "positions" && <PositionsTable onSelectSymbol={selectSymbol} />}
          {tab === "orders" && <OrdersTable onSelectSymbol={selectSymbol} />}
          {tab === "history" && <TradeHistory onSelectSymbol={selectSymbol} />}
          {tab === "signals" && (
            <SignalFeed onSelectSymbol={selectSymbol} filterSymbol={signalScope === "symbol" ? symbol : null} />
          )}
        </div>
      </section>

      <aside className="side-col area-side">
        <SignalAction symbol={symbol} onSelectSymbol={selectSymbol} />
        <OrderPanel symbol={symbol} />
        <AccountPanel />
        <div className="panel" style={{ flex: 1, minHeight: 220 }}>
          <div className="panel-header">
            Son açık sinyaller
            <span className="count">{openSignalCount}</span>
          </div>
          <div className="panel-body">
            <SignalFeed onSelectSymbol={selectSymbol} onlyOpen />
          </div>
        </div>
      </aside>
    </main>
  );
}
