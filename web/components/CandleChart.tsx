"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  createChart,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type SeriesType,
  type UTCTimestamp,
} from "lightweight-charts";
import {
  bollinger,
  describeTrack,
  ema,
  INTERVAL_MS,
  macd,
  rsi,
  type Candle,
  type Interval,
  type PendingOrder,
  type Position,
  type HistorySignal,
  type PriceLevel,
  type Signal,
} from "@signal-lab/shared";
import { api } from "@/lib/api";
import { fmtCompact, fmtPrice, priceDecimals } from "@/lib/format";
import { socket } from "@/lib/socket";

export interface IndicatorToggles {
  ema: boolean;
  bb: boolean;
  volume: boolean;
  rsi: boolean;
  macd: boolean;
  levels: boolean;
}

interface Props {
  symbol: string;
  interval: Interval;
  indicators: IndicatorToggles;
  signals: Signal[];
  positions: Position[];
  orders: PendingOrder[];
  /** Teknik analizden gelen destek/direnç seviyeleri */
  levels: PriceLevel[];
  /** Gün açılışı, hafta açılışı ve günlük VWAP */
  sessionLevels?: { dayOpen: number | null; weekOpen: number | null; vwap: number | null } | null;
  /** Backtest'in bu coinde geçmişte verdiği AL sinyalleri (giriş + çıkış) */
  historySignals?: HistorySignal[];
}

/** Grafikte parlayan nokta: yeşil = AL (giriş), kırmızı = SAT (çıkış/hedef) */
interface Light {
  key: string;
  kind: "buy" | "sell";
  time: number;
  price: number;
  /** Canlı (açık sinyal) ise nabız gibi atar */
  live: boolean;
  /** Dolmayan akıllı giriş: içi boş halka */
  hollow?: boolean;
  /** A kalite (daha zayıf) sinyal: küçük ve soluk çizilir */
  minor?: boolean;
  label: string;
  title: string;
}

const COLORS = {
  bg: "#131722",
  grid: "rgba(42, 46, 57, 0.5)",
  text: "#8a91a5",
  border: "#252a37",
  up: "#089981",
  down: "#f23645",
  upVol: "rgba(8, 153, 129, 0.45)",
  downVol: "rgba(242, 54, 69, 0.45)",
  ema9: "#f7c948",
  ema21: "#2962ff",
  ema50: "#ab47bc",
  ema200: "#ff9800",
  bb: "rgba(41, 182, 246, 0.6)",
  bbMid: "rgba(41, 182, 246, 0.35)",
  rsi: "#7e57c2",
  macd: "#2962ff",
  macdSignal: "#ff9800",
  entry: "#5b8cff",
  liq: "#ff9800",
  order: "#b0b6c6",
};

const EMA_SET = [
  { period: 9, color: COLORS.ema9 },
  { period: 21, color: COLORS.ema21 },
  { period: 50, color: COLORS.ema50 },
  { period: 200, color: COLORS.ema200 },
];

/** lightweight-charts UTC gösterir; yerel saat için zaman damgalarını kaydırıyoruz. */
const TZ_OFFSET_S = typeof window === "undefined" ? 0 : -new Date().getTimezoneOffset() * 60;
const toTime = (ms: number) => (Math.floor(ms / 1000) + TZ_OFFSET_S) as UTCTimestamp;

const MAX_CANDLES = 5000;

interface Legend {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  changePct: number;
}

type AnySeries = ISeriesApi<SeriesType>;

export function CandleChart({ symbol, interval, indicators, signals, positions, orders, levels, sessionLevels, historySignals = [] }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const lightRefs = useRef(new Map<string, HTMLDivElement>());
  const lightsRef = useRef<Light[]>([]);
  const levelLinesRef = useRef<IPriceLine[]>([]);
  const indicatorSeriesRef = useRef<AnySeries[]>([]);
  const indicatorUpdateRef = useRef<(candles: Candle[]) => void>(() => {});
  const priceLinesRef = useRef<IPriceLine[]>([]);
  const candlesRef = useRef<Candle[]>([]);
  const symbolRef = useRef(symbol);
  const intervalRef = useRef(interval);
  const loadingMoreRef = useRef(false);
  const noMoreRef = useRef(false);
  const rafRef = useRef<number | null>(null);
  const hoverRef = useRef(false);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [legend, setLegend] = useState<Legend | null>(null);
  const [dataVersion, setDataVersion] = useState(0);

  symbolRef.current = symbol;
  intervalRef.current = interval;

  // ---- 1) Grafiği bir kez oluştur ----
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: COLORS.bg },
        textColor: COLORS.text,
        fontSize: 11,
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        panes: { separatorColor: COLORS.border, separatorHoverColor: "#323849" },
        attributionLogo: true,
      },
      grid: { vertLines: { color: COLORS.grid }, horzLines: { color: COLORS.grid } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: COLORS.border },
      timeScale: { borderColor: COLORS.border, timeVisible: true, secondsVisible: false, rightOffset: 6 },
      localization: { locale: "tr-TR" },
    });

    const candles = chart.addSeries(CandlestickSeries, {
      upColor: COLORS.up,
      downColor: COLORS.down,
      borderUpColor: COLORS.up,
      borderDownColor: COLORS.down,
      wickUpColor: COLORS.up,
      wickDownColor: COLORS.down,
    });
    candles.priceScale().applyOptions({ scaleMargins: { top: 0.08, bottom: 0.18 } });

    const volume = chart.addSeries(HistogramSeries, {
      priceScaleId: "vol",
      priceFormat: { type: "volume" },
      lastValueVisible: false,
      priceLineVisible: false,
    });
    chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.84, bottom: 0 }, visible: false });

    chartRef.current = chart;
    candleRef.current = candles;
    volumeRef.current = volume;

    chart.subscribeCrosshairMove((param) => {
      const bar = param.time ? param.seriesData.get(candles) : undefined;
      if (bar && "open" in bar) {
        hoverRef.current = true;
        const idx = candlesRef.current.findIndex((c) => toTime(c.openTime) === param.time);
        const c = candlesRef.current[idx];
        if (c) setLegend(legendOf(c));
      } else {
        hoverRef.current = false;
        const last = candlesRef.current[candlesRef.current.length - 1];
        if (last) setLegend(legendOf(last));
      }
    });

    chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      if (range && range.from < 30) void loadMore();
    });

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
      volumeRef.current = null;
      indicatorSeriesRef.current = [];
      priceLinesRef.current = [];
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- 2) Sembol/aralık değişince veriyi yükle ve canlı akışa abone ol ----
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    noMoreRef.current = false;
    candlesRef.current = [];
    socket.subscribe(symbol, interval);

    api
      .klines(symbol, interval, 1000)
      .then((data) => {
        if (cancelled || !candleRef.current) return;
        candlesRef.current = data;
        const ref = data[data.length - 1]?.close ?? 1;
        const precision = priceDecimals(ref);
        candleRef.current.applyOptions({
          priceFormat: { type: "price", precision, minMove: 1 / 10 ** precision },
        });
        renderAll();
        const n = data.length;
        chartRef.current?.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - 160), to: n + 6 });
        setLoading(false);
        setDataVersion((v) => v + 1);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setError(err.message);
        setLoading(false);
      });

    const off = socket.on((msg) => {
      if (msg.type !== "candle") return;
      const c = msg.data;
      if (c.symbol !== symbol || c.interval !== interval || candlesRef.current.length === 0) return;
      const arr = candlesRef.current;
      const last = arr[arr.length - 1];
      if (c.openTime === last.openTime) arr[arr.length - 1] = c;
      else if (c.openTime > last.openTime) {
        arr.push(c);
        if (arr.length > MAX_CANDLES) arr.splice(0, arr.length - MAX_CANDLES);
      } else return;
      candleRef.current?.update(toBar(c));
      volumeRef.current?.update(toVolume(c));
      scheduleRefresh();
    });

    return () => {
      cancelled = true;
      off();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, interval]);

  // ---- 3) İndikatör serilerini aç/kapat ----
  const indicatorKey = `${indicators.ema}${indicators.bb}${indicators.rsi}${indicators.macd}`;
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    for (const s of indicatorSeriesRef.current) chart.removeSeries(s);
    indicatorSeriesRef.current = [];
    for (let i = chart.panes().length - 1; i > 0; i--) {
      try {
        chart.removePane(i);
      } catch {
        /* boş pane zaten kaldırılmış olabilir */
      }
    }

    const updaters: ((candles: Candle[], closes: number[]) => void)[] = [];
    const line = (color: string, pane: number, opts: Record<string, unknown> = {}) => {
      const s = chart.addSeries(
        LineSeries,
        {
          color,
          lineWidth: 1,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
          ...opts,
        },
        pane,
      );
      indicatorSeriesRef.current.push(s as AnySeries);
      return s;
    };

    if (indicators.ema) {
      for (const { period, color } of EMA_SET) {
        const s = line(color, 0, { lineWidth: period === 200 ? 2 : 1, title: `EMA${period}` });
        updaters.push((c, closes) => s.setData(toLine(c, ema(closes, period))));
      }
    }

    if (indicators.bb) {
      const upper = line(COLORS.bb, 0);
      const mid = line(COLORS.bbMid, 0, { lineStyle: LineStyle.Dashed });
      const lower = line(COLORS.bb, 0);
      updaters.push((c, closes) => {
        const bb = bollinger(closes, 20, 2);
        upper.setData(toLine(c, bb.upper));
        mid.setData(toLine(c, bb.middle));
        lower.setData(toLine(c, bb.lower));
      });
    }

    let pane = 1;
    if (indicators.rsi) {
      const s = line(COLORS.rsi, pane, { lastValueVisible: true, title: "RSI 14" });
      s.createPriceLine({ price: 70, color: "rgba(242,54,69,0.5)", lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: false, title: "" });
      s.createPriceLine({ price: 30, color: "rgba(8,153,129,0.6)", lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: false, title: "" });
      s.applyOptions({ autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } }) });
      updaters.push((c, closes) => s.setData(toLine(c, rsi(closes, 14))));
      pane++;
    }

    if (indicators.macd) {
      const hist = chart.addSeries(
        HistogramSeries,
        { priceLineVisible: false, lastValueVisible: false },
        pane,
      );
      indicatorSeriesRef.current.push(hist as AnySeries);
      const m = line(COLORS.macd, pane, { title: "MACD" });
      const sig = line(COLORS.macdSignal, pane);
      updaters.push((c, closes) => {
        const r = macd(closes);
        m.setData(toLine(c, r.macd));
        sig.setData(toLine(c, r.signal));
        const data = [];
        for (let i = 0; i < c.length; i++) {
          const v = r.histogram[i];
          if (!Number.isFinite(v)) continue;
          const prev = r.histogram[i - 1];
          const rising = Number.isFinite(prev) ? v >= prev : true;
          const color = v >= 0 ? (rising ? "#26a69a" : "#b2dfdb") : rising ? "#ffcdd2" : "#ef5350";
          data.push({ time: toTime(c[i].openTime), value: v, color });
        }
        hist.setData(data);
      });
      pane++;
    }

    const panes = chart.panes();
    for (let i = 1; i < panes.length; i++) panes[i].setHeight(110);

    indicatorUpdateRef.current = (candles) => {
      const closes = candles.map((c) => c.close);
      for (const u of updaters) u(candles, closes);
    };
    if (candlesRef.current.length) indicatorUpdateRef.current(candlesRef.current);
  }, [indicatorKey]);

  useEffect(() => {
    volumeRef.current?.applyOptions({ visible: indicators.volume });
  }, [indicators.volume]);

  // ---- 4) Sinyal ışıkları: alış = yeşil, satış/çıkış = kırmızı ----
  const lights = useMemo<Light[]>(() => {
    const out: Light[] = [];
    const ivMs = INTERVAL_MS[interval];
    const bucket = (t: number) => Math.floor(t / ivMs) * ivMs;
    for (const s of signals) {
      const long = s.side === "LONG";
      const open = s.status === "OPEN";
      const conf = ` • karne: ${describeTrack(s.history).text}`;
      out.push({
        key: `${s.id}:in`,
        kind: long ? "buy" : "sell",
        // Sinyal mum KAPANIŞINDA oluşur: ışık, kapanış anını içeren muma konur
        // (1s sinyal 15dk grafikte saatin son 15 dakikasında görünür)
        time: bucket(s.createdAt - 1),
        price: s.price,
        live: open,
        label: long ? "AL" : "SAT",
        title: `${long ? "AL" : "SAT"} sinyali @ ${fmtPrice(s.price)}${conf}\n${s.reasons.join("\n")}`,
      });
      if (!open && s.closedAt && s.closePrice) {
        const profit = (s.resultPct ?? 0) > 0;
        out.push({
          key: `${s.id}:out`,
          kind: long ? "sell" : "buy",
          time: bucket(s.closedAt),
          price: s.closePrice,
          live: false,
          label: long ? "SAT" : "AL",
          title: `Çıkış @ ${fmtPrice(s.closePrice)} — ${s.status === "TP_HIT" ? "hedef geldi" : s.status === "SL_HIT" ? (profit ? "başa baş stop (kârda)" : "stop oldu") : "süre doldu"} (${(s.resultPct ?? 0).toFixed(2)}%)`,
        });
      }
    }
    // Geçmiş sinyaller (backtest): canlı listede olmayanlar
    const liveTimes = new Set(signals.map((s) => s.candleTime));
    const O: Record<HistorySignal["outcome"], string> = {
      TP: "hedefe ulaştı ✓",
      SL: "stop oldu ✗",
      BE: "stop girişe çekilmişti, başa başta (ücret kadar eksi) kapandı",
      EXPIRED: "48 saatte sonuçlanmadı",
      MISSED: "akıllı giriş emri dolmadı (fırsat kaçtı)",
    };
    for (const h of historySignals) {
      if (liveTimes.has(h.candleTime)) continue;
      const pct = h.netPct != null ? ` (${h.netPct >= 0 ? "+" : ""}${h.netPct.toFixed(2)}%)` : "";
      // Akıllı girişte dolum mumunda, diğerlerinde sinyal mumunun kapanışında
      const entryAt = h.quality === "A+" && h.outcome !== "MISSED" ? bucket(h.entryTime) : bucket(h.entryTime - 1);
      out.push({
        key: `h:${h.candleTime}:in`,
        kind: "buy",
        time: entryAt,
        price: h.entry,
        live: false,
        hollow: h.outcome === "MISSED",
        minor: h.quality !== "A+",
        label: h.quality === "A+" ? "AL A+" : "AL",
        title: `Geçmiş ${h.quality} AL sinyali @ ${fmtPrice(h.entry)}\nHedef ${fmtPrice(h.takeProfit)} • Stop ${fmtPrice(h.stopLoss)}\nSonuç: ${O[h.outcome]}${pct}`,
      });
      if (h.exit != null && h.exitTime != null) {
        out.push({
          key: `h:${h.candleTime}:out`,
          kind: "sell",
          time: bucket(h.exitTime),
          price: h.exit,
          live: false,
          minor: h.quality !== "A+",
          label: h.outcome === "TP" ? "SAT ✓" : h.outcome === "SL" ? "STOP" : "SAT",
          title: `Çıkış @ ${fmtPrice(h.exit)} — ${O[h.outcome]}${pct}`,
        });
      }
    }

    // Açık pozisyon: nerede satılacağı (hedef) — canlı kırmızı ışık
    const nowBucket = bucket(Date.now());
    for (const p of positions) {
      if (!p.takeProfit) continue;
      const gain = (p.takeProfit - p.entryPrice) * p.quantity * (p.side === "LONG" ? 1 : -1);
      out.push({
        key: `pos:${p.id}:tp`,
        kind: p.side === "LONG" ? "sell" : "buy",
        time: nowBucket,
        price: p.takeProfit,
        live: true,
        label: `SAT ${fmtPrice(p.takeProfit)}`,
        title: `Açık pozisyonun satış noktası (hedef): ${fmtPrice(p.takeProfit)} — fiyat buraya gelince otomatik satılır (≈ ${gain >= 0 ? "+" : ""}${gain.toFixed(2)} USDT)`,
      });
    }
    return out;
  }, [signals, interval, historySignals, positions]);
  lightsRef.current = lights;

  // ---- AL sinyali gezgini: listedeki sinyale tıklayınca grafik oraya kayar ----
  const navItems = useMemo<NavItem[]>(() => {
    const items: NavItem[] = historySignals.map((h) => ({
      key: `h:${h.candleTime}`,
      time: h.candleTime,
      quality: h.quality,
      outcome: h.outcome,
      netPct: h.netPct,
    }));
    const hist = new Set(historySignals.map((h) => h.candleTime));
    for (const s of signals) {
      if (hist.has(s.candleTime) || s.kind !== "consensus") continue;
      items.push({
        key: `s:${s.id}`,
        time: s.candleTime,
        quality: s.quality ?? "A",
        outcome:
          s.status === "OPEN"
            ? "OPEN"
            : s.status === "TP_HIT"
              ? "TP"
              : s.status === "SL_HIT"
                ? s.stopMoved
                  ? "BE"
                  : "SL"
                : s.status === "MISSED"
                  ? "MISSED"
                  : "EXPIRED",
        netPct: s.resultPct,
      });
    }
    return items.sort((a, b) => b.time - a.time);
  }, [historySignals, signals]);

  const goTo = (time: number) => {
    const chart = chartRef.current;
    const candles = candlesRef.current;
    if (!chart || !candles.length) return;
    const ivMs = INTERVAL_MS[interval];
    let idx = candles.findIndex((c) => c.openTime + ivMs > time);
    if (idx < 0) idx = candles.length - 1;
    const half = 70;
    chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, idx - half), to: Math.min(candles.length + 6, idx + half) });
  };

  // Ekranın solunda kalan sinyal sayısı (kullanıcıya "← N sinyal" ipucu)
  const [offscreenLeft, setOffscreenLeft] = useState(0);
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const update = () => {
      const range = chart.timeScale().getVisibleRange();
      if (!range) return;
      const from = (range.from as number) - TZ_OFFSET_S;
      setOffscreenLeft(navItems.filter((n) => n.time / 1000 < from).length);
    };
    update();
    chart.timeScale().subscribeVisibleTimeRangeChange(update);
    return () => chart.timeScale().unsubscribeVisibleTimeRangeChange(update);
  }, [navItems, dataVersion]);

  // Grafik açılınca en son AL sinyali görünmüyorsa oraya kaydır (sembol/aralık başına bir kez)
  const autoScrolled = useRef("");
  useEffect(() => {
    const key = `${symbol}:${interval}`;
    if (autoScrolled.current === key || loading || !navItems.length || !candlesRef.current.length) return;
    autoScrolled.current = key;
    const latest = navItems[0].time;
    const candles = candlesRef.current;
    const ivMs = INTERVAL_MS[interval];
    const idx = candles.findIndex((c) => c.openTime + ivMs > latest);
    if (idx >= 0 && idx < candles.length - 150) {
      chartRef.current?.timeScale().setVisibleLogicalRange({ from: Math.max(0, idx - 30), to: candles.length + 6 });
    }
  }, [navItems, loading, symbol, interval, dataVersion]);

  // Işıkları grafik koordinatlarına her karede yerleştir (kaydırma, yakınlaştırma, ölçek değişimi)
  useEffect(() => {
    let raf = 0;
    const place = () => {
      raf = requestAnimationFrame(place);
      const chart = chartRef.current;
      const series = candleRef.current;
      if (!chart || !series) return;
      const ts = chart.timeScale();
      const first = candlesRef.current[0]?.openTime ?? Infinity;
      for (const l of lightsRef.current) {
        const el = lightRefs.current.get(l.key);
        if (!el) continue;
        const x = l.time >= first ? ts.timeToCoordinate(toTime(l.time)) : null;
        const y = series.priceToCoordinate(l.price);
        if (x == null || y == null) {
          el.style.display = "none";
          continue;
        }
        el.style.display = "";
        el.style.transform = `translate(${x}px, ${y}px)`;
      }
    };
    raf = requestAnimationFrame(place);
    return () => cancelAnimationFrame(raf);
  }, []);

  // ---- Açık sinyalin hedef/stop çizgileri + destek/direnç ----
  const activeSignal = useMemo(
    () => signals.filter((s) => s.status === "OPEN").sort((a, b) => b.createdAt - a.createdAt)[0] ?? null,
    [signals],
  );
  const levelsKey = useMemo(
    () =>
      (indicators.levels ? levels.map((l) => `${l.kind}${l.price.toFixed(8)}${l.touches}`).join("|") : "") +
      (activeSignal ? `#${activeSignal.id}${activeSignal.stopLoss}${activeSignal.takeProfit}` : "") +
      (indicators.levels && sessionLevels
        ? `@${sessionLevels.dayOpen}${sessionLevels.weekOpen}${sessionLevels.vwap?.toPrecision(5)}`
        : "") +
      `P${positions.map((p) => p.takeProfit).join(",")}`,
    [levels, indicators.levels, activeSignal, sessionLevels, positions],
  );
  useEffect(() => {
    const series = candleRef.current;
    if (!series) return;
    for (const l of levelLinesRef.current) series.removePriceLine(l);
    levelLinesRef.current = [];
    if (indicators.levels) {
      for (const l of levels) {
        levelLinesRef.current.push(
          series.createPriceLine({
            price: l.price,
            color: l.kind === "support" ? "rgba(14,203,129,0.45)" : "rgba(246,70,93,0.45)",
            lineWidth: l.touches >= 4 ? 2 : 1,
            lineStyle: LineStyle.Dashed,
            axisLabelVisible: true,
            axisLabelColor: l.kind === "support" ? "rgba(8,153,129,0.75)" : "rgba(217,48,74,0.75)",
            title: `${l.kind === "support" ? "Destek" : "Direnç"}${l.touches >= 4 ? " (güçlü)" : ""}`,
          }),
        );
      }
    }
    if (indicators.levels && sessionLevels) {
      const add = (price: number | null, title: string, color: string, style: LineStyle) => {
        if (price) levelLinesRef.current.push(series.createPriceLine({ price, color, lineWidth: 1, lineStyle: style, axisLabelVisible: true, title }));
      };
      add(sessionLevels.dayOpen, "Gün açılışı", "rgba(41,182,246,0.8)", LineStyle.SparseDotted);
      add(sessionLevels.weekOpen, "Hafta açılışı", "rgba(171,71,188,0.85)", LineStyle.SparseDotted);
      add(sessionLevels.vwap, "VWAP (gün ort.)", "rgba(240,185,11,0.7)", LineStyle.Dotted);
    }
    // Sinyalle aynı SL/TP'ye sahip pozisyon varsa çizgiler pozisyondan zaten çiziliyor
    const covered =
      activeSignal &&
      positions.some((p) => p.takeProfit != null && Math.abs(p.takeProfit - activeSignal.takeProfit) / activeSignal.takeProfit < 1e-6);
    if (activeSignal && !covered && activeSignal.entryLimit && (activeSignal.entryValidUntil ?? 0) > Date.now()) {
      levelLinesRef.current.push(
        series.createPriceLine({
          price: activeSignal.entryLimit,
          color: "#4dffb0",
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: "Akıllı giriş",
        }),
      );
    }
    if (activeSignal && !covered) {
      const long = activeSignal.side === "LONG";
      levelLinesRef.current.push(
        series.createPriceLine({
          price: activeSignal.takeProfit,
          color: long ? "#f6465d" : "#0ecb81",
          lineWidth: 2,
          lineStyle: LineStyle.Solid,
          axisLabelVisible: true,
          title: long ? "SAT hedefi (TP)" : "AL hedefi (TP)",
        }),
        series.createPriceLine({
          price: activeSignal.stopLoss,
          color: "#ff9800",
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: activeSignal.stopMoved ? "Stop (başa baş)" : "Zarar kes (SL)",
        }),
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [levelsKey, dataVersion]);

  // ---- 5) Pozisyon / emir çizgileri ----
  const linesKey = useMemo(
    () =>
      positions
        .map((p) => [p.id, p.side, p.leverage, p.entryPrice, p.stopLoss, p.takeProfit, p.liquidationPrice].join(","))
        .concat(orders.map((o) => [o.id, o.side, o.price].join(",")))
        .join("|"),
    [positions, orders],
  );
  useEffect(() => {
    const series = candleRef.current;
    if (!series) return;
    for (const l of priceLinesRef.current) series.removePriceLine(l);
    priceLinesRef.current = [];
    const add = (price: number, color: string, title: string, style: LineStyle, width: 1 | 2 = 1) =>
      priceLinesRef.current.push(
        series.createPriceLine({ price, color, title, lineStyle: style, lineWidth: width, axisLabelVisible: true }),
      );
    for (const p of positions) {
      add(p.entryPrice, COLORS.entry, `Giriş ${p.side} ${p.leverage}x`, LineStyle.Solid, 2);
      if (p.stopLoss) {
        const safe = p.side === "LONG" ? p.stopLoss >= p.entryPrice : p.stopLoss <= p.entryPrice;
        add(p.stopLoss, safe ? COLORS.up : COLORS.down, safe ? "Stop girişte (başa baş)" : "Zarar kes (stop)", LineStyle.Dashed);
        // Başa baş tetik seviyesi: fiyat buraya gelince stop girişe çekilir
        if (!safe && p.breakevenAtR) {
          const r = Math.abs(p.entryPrice - p.stopLoss);
          add(p.entryPrice + (p.side === "LONG" ? 1 : -1) * r * p.breakevenAtR, "rgba(41,182,246,0.8)", "Burada stop girişe çekilir", LineStyle.Dotted);
        }
      }
      if (p.takeProfit) add(p.takeProfit, "#f6465d", "SAT (hedef)", LineStyle.Solid, 2);
      if (p.liquidationPrice > 0) add(p.liquidationPrice, COLORS.liq, "Likidasyon", LineStyle.Dotted);
    }
    for (const o of orders) add(o.price, COLORS.order, `Limit ${o.side}`, LineStyle.LargeDashed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linesKey, dataVersion]);

  // ---- yardımcılar ----
  function renderAll() {
    const candles = candlesRef.current;
    candleRef.current?.setData(candles.map(toBar));
    volumeRef.current?.setData(candles.map(toVolume));
    indicatorUpdateRef.current(candles);
    const last = candles[candles.length - 1];
    if (last) setLegend(legendOf(last));
  }

  function scheduleRefresh() {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      const candles = candlesRef.current;
      indicatorUpdateRef.current(candles);
      if (!hoverRef.current && candles.length) setLegend(legendOf(candles[candles.length - 1]));
    });
  }

  async function loadMore() {
    const candles = candlesRef.current;
    if (loadingMoreRef.current || noMoreRef.current || candles.length === 0 || candles.length >= MAX_CANDLES) return;
    loadingMoreRef.current = true;
    const sym = symbolRef.current;
    const iv = intervalRef.current;
    const firstTime = candles[0].openTime;
    try {
      const older = await api.klines(sym, iv, 1000, firstTime - 1);
      if (sym !== symbolRef.current || iv !== intervalRef.current) return;
      const fresh = older.filter((c) => c.openTime < firstTime);
      if (fresh.length === 0) {
        noMoreRef.current = true;
        return;
      }
      candlesRef.current = [...fresh, ...candlesRef.current];
      renderAll();
      setDataVersion((v) => v + 1);
    } catch {
      /* sessizce yoksay; kullanıcı tekrar kaydırınca yeniden denenir */
    } finally {
      loadingMoreRef.current = false;
    }
  }

  const changeCls = legend ? (legend.changePct >= 0 ? "up" : "down") : "";

  return (
    <div className="chart-wrap">
      <div ref={containerRef} className="chart-container" />
      <div className="light-layer" aria-hidden>
        {lights.map((l) => (
          <div
            key={l.key}
            ref={(el) => {
              if (el) lightRefs.current.set(l.key, el);
              else lightRefs.current.delete(l.key);
            }}
            className={`light ${l.kind}${l.live ? " live" : ""}${l.hollow ? " hollow" : ""}${l.minor ? " minor" : ""}`}
            style={{ display: "none" }}
            title={l.title}
          >
            <span className="light-core" />
            <span className="light-label">{l.label}</span>
          </div>
        ))}
      </div>
      {legend && (
        <div className="chart-legend num">
          <div className="row">
            <span>
              <b>A</b>
              <span className={changeCls}>{fmtPrice(legend.open)}</span>
            </span>
            <span>
              <b>Y</b>
              <span className={changeCls}>{fmtPrice(legend.high)}</span>
            </span>
            <span>
              <b>D</b>
              <span className={changeCls}>{fmtPrice(legend.low)}</span>
            </span>
            <span>
              <b>K</b>
              <span className={changeCls}>{fmtPrice(legend.close)}</span>
            </span>
            <span className={changeCls}>
              {legend.changePct >= 0 ? "+" : ""}
              {legend.changePct.toFixed(2)}%
            </span>
            <span>
              <b>Hacim</b>
              {fmtCompact(legend.volume)}
            </span>
          </div>
          {indicators.ema && (
            <div className="row">
              {EMA_SET.map((e) => (
                <span key={e.period} style={{ color: e.color }}>
                  EMA{e.period}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
      <SignalNavigator
        items={navItems}
        onGo={goTo}
        offscreenLeft={offscreenLeft}
      />
      {(loading || error) && <div className="chart-loading">{error ?? "Grafik yükleniyor…"}</div>}
    </div>
  );
}

function toBar(c: Candle) {
  return { time: toTime(c.openTime), open: c.open, high: c.high, low: c.low, close: c.close };
}

function toVolume(c: Candle) {
  return { time: toTime(c.openTime), value: c.volume, color: c.close >= c.open ? COLORS.upVol : COLORS.downVol };
}

function toLine(candles: Candle[], values: number[]) {
  const out: { time: UTCTimestamp; value: number }[] = [];
  for (let i = 0; i < candles.length; i++) {
    if (Number.isFinite(values[i])) out.push({ time: toTime(candles[i].openTime), value: values[i] });
  }
  return out;
}

function legendOf(c: Candle): Legend {
  return {
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume,
    changePct: c.open ? ((c.close - c.open) / c.open) * 100 : 0,
  };
}

interface NavItem {
  key: string;
  time: number;
  quality: "A+" | "A";
  outcome: "TP" | "SL" | "BE" | "EXPIRED" | "MISSED" | "OPEN";
  netPct: number | null | undefined;
}

const OUTCOME_SHORT: Record<NavItem["outcome"], { label: string; cls: string }> = {
  TP: { label: "hedef ✓", cls: "up" },
  SL: { label: "stop ✗", cls: "down" },
  BE: { label: "başa baş", cls: "" },
  EXPIRED: { label: "süre doldu", cls: "faint" },
  MISSED: { label: "dolmadı", cls: "faint" },
  OPEN: { label: "AÇIK", cls: "up" },
};

/** Grafiğin sağ üstünde: bu coindeki AL sinyallerinin listesi; tıklayınca grafik oraya gider. */
function SignalNavigator({ items, onGo, offscreenLeft }: { items: NavItem[]; onGo: (t: number) => void; offscreenLeft: number }) {
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  if (!items.length) {
    return <div className="sig-nav empty">Bu coinde son 60 günde AL sinyali yok</div>;
  }
  const go = (i: number) => {
    const c = Math.max(0, Math.min(items.length - 1, i));
    setCursor(c);
    onGo(items[c].time);
  };
  const aPlus = items.filter((i) => i.quality === "A+").length;
  return (
    <div className="sig-nav">
      <div className="sig-nav-head">
        <button className="sig-nav-btn" onClick={() => go(cursor + 1)} title="Daha eski sinyal">
          ◀
        </button>
        <button className="sig-nav-title" onClick={() => setOpen(!open)}>
          🟢 AL sinyalleri: {items.length} <span className="faint">({aPlus} A+)</span>
          {offscreenLeft > 0 && <span className="sig-nav-hint"> • ← {offscreenLeft} solda</span>}
        </button>
        <button className="sig-nav-btn" onClick={() => go(cursor - 1)} title="Daha yeni sinyal">
          ▶
        </button>
      </div>
      {open && (
        <div className="sig-nav-list">
          {items.slice(0, 40).map((it, i) => {
            const o = OUTCOME_SHORT[it.outcome];
            return (
              <button key={it.key} className={`sig-nav-row${i === cursor ? " active" : ""}`} onClick={() => go(i)}>
                <span className="num">{new Date(it.time).toLocaleString("tr-TR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</span>
                <span className={`quality ${it.quality === "A+" ? "aplus" : "a"}`}>{it.quality}</span>
                <span className={o.cls}>{o.label}</span>
                <span className={`num ${it.netPct == null ? "faint" : it.netPct >= 0 ? "up" : "down"}`}>
                  {it.netPct == null ? "" : `${it.netPct >= 0 ? "+" : ""}${it.netPct.toFixed(2)}%`}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
