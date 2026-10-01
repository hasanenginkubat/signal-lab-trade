import {
  findLevels,
  type AnalysisPoint,
  type Candle,
  type ConsensusView,
  type Interval,
  type PriceLevel,
  type TechnicalAnalysis,
  type TimeframeView,
  type TradePlan,
  type Trend,
  type Verdict,
} from "@signal-lab/shared";
import type { BacktestService } from "../backtest/service";
import type { Config } from "../config";
import type { MarketData } from "../market/marketData";
import type { SignalEngine } from "../signals/engine";
import { evaluate, trendOf, type Snapshot } from "../signals/strategy";

const TIMEFRAMES: Interval[] = ["15m", "1h", "4h", "1d"];
const CACHE_MS = 10_000;

const TF_TR: Record<Interval, string> = {
  "1m": "1 dakikalık",
  "5m": "5 dakikalık",
  "15m": "15 dakikalık",
  "1h": "1 saatlik",
  "4h": "4 saatlik",
  "1d": "günlük",
};

/**
 * Bir coin için grafik okumayı bilmeyen birinin de anlayacağı teknik analiz üretir:
 * karar (AL / BEKLE / SAT), sade dille gerekçeler, destek-direnç seviyeleri, zaman dilimleri
 * özeti ve uygun ise giriş/stop/hedef planı.
 */
export class Analyzer {
  private cache = new Map<string, { at: number; value: TechnicalAnalysis }>();

  constructor(
    private readonly market: MarketData,
    private readonly engine: SignalEngine,
    private readonly backtests: BacktestService,
    private readonly cfg: Config,
  ) {}

  async analyze(symbol: string, interval: Interval): Promise<TechnicalAnalysis> {
    const key = `${symbol}:${interval}`;
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;

    const candles = await this.market.getClosedCandles(symbol, interval, this.cfg.historyLimit);
    const higher = await this.engine.higherCandles(symbol, interval);
    const result = evaluate(candles, this.cfg.strategy, higher);
    const snap = result.snapshot;
    const price = this.market.getPrice(symbol) ?? candles[candles.length - 1]?.close ?? 0;

    // Zaman dilimi trendleri: konsensüsteki "Trend uyumu" ile AYNI tanım (trendOf)
    const timeframes: TimeframeView[] = [];
    for (const tf of TIMEFRAMES) {
      try {
        const c = tf === interval ? candles : await this.market.getClosedCandles(symbol, tf, 400);
        const r = tf === interval ? result : evaluate(c, this.cfg.strategy);
        timeframes.push({ interval: tf, trend: trendOf(c), score: r.score, rsi: r.rsi });
      } catch {
        /* bu aralık için veri alınamadı */
      }
    }

    // KARAR, PLAN ve UYUM tek kaynaktan: sinyal kapısı (motorun görünümü)
    let consensus = this.engine.getView(symbol);
    if (!consensus) {
      const { result: r, h1 } = await this.engine.computeConsensus(symbol);
      consensus = this.engine.toView(symbol, r, h1[h1.length - 1]?.openTime ?? null);
    }
    const verdict = verdictFromView(consensus, this.cfg.consensus.threshold);
    const plan = planFromView(consensus);
    const confidence = consensus.confidence;

    const levels = snap ? buildLevels(candles, price, snap.atr) : [];
    const points = snap ? explain(snap, result.higherTrend, interval, levels, price, trendOf(candles)) : [];
    const atrPct = snap && price ? (snap.atr / price) * 100 : 0;
    const volLevel = volatilityLevel(atrPct, interval);
    const track = this.backtests.record(symbol, "1h");

    const analysis: TechnicalAnalysis = {
      symbol,
      interval,
      price,
      updatedAt: Date.now(),
      verdict,
      score: consensus.score / 10,
      confidence,
      headline: headline(verdict, consensus),
      summary: summarize(verdict, timeframes, snap, consensus),
      points,
      timeframes,
      levels,
      plan,
      volatility: {
        atrPct,
        level: volLevel,
        text:
          volLevel === "high"
            ? `Fiyat bir mumda ortalama %${atrPct.toFixed(2)} oynuyor — hareketli. Kaldıracı düşük tutun, stop'u geniş koyun.`
            : volLevel === "low"
              ? `Fiyat bir mumda ortalama sadece %${atrPct.toFixed(2)} oynuyor — sakin. Büyük hareket için sabır gerekir.`
              : `Fiyat bir mumda ortalama %${atrPct.toFixed(2)} oynuyor — normal hareketlilik.`,
      },
      indicators: {
        rsi: finite(snap?.rsi),
        adx: finite(snap?.adx),
        macdHistogram: finite(snap?.macdHist),
        ema21: finite(snap?.ema21),
        ema50: finite(snap?.ema50),
        ema200: finite(snap?.ema200),
      },
      track,
      consensus,
    };
    this.cache.set(key, { at: Date.now(), value: analysis });
    return analysis;
  }
}

function finite(v: number | undefined): number | null {
  return v !== undefined && Number.isFinite(v) ? v : null;
}

/**
 * Karar YALNIZCA sinyal kapısından: kapı geçtiyse AL / GÜÇLÜ AL (A+), geçmediyse en fazla NEUTRAL.
 * Skor çok düşükse AVOID ("uzak dur"). ADX < minAdx iken kapı geçemez → asla AL değildir.
 */
export function verdictFromView(v: Pick<ConsensusView, "passed" | "quality" | "plan" | "score">, threshold: number): Verdict {
  if (v.passed && v.plan) {
    if (v.plan.side === "SHORT") return v.quality === "A+" ? "STRONG_SELL" : "SELL";
    return v.quality === "A+" ? "STRONG_BUY" : "BUY";
  }
  if (v.score <= -threshold) return "AVOID";
  return "NEUTRAL";
}

/** Plan yalnızca kapı geçildiyse; giriş/stop/hedef sinyal mumunun kapanışından */
export function planFromView(v: Pick<ConsensusView, "passed" | "plan">): TradePlan | null {
  const p = v.passed ? v.plan : null;
  if (!p) return null;
  const long = p.side === "LONG";
  let note =
    `Giriş ${fmt(p.entry)} (sinyal mumunun kapanışı), zarar kes ${fmt(p.stopLoss)} (%${((Math.abs(p.entry - p.stopLoss) / p.entry) * 100).toFixed(2)} risk), ` +
    `hedef ${fmt(p.takeProfit)} — R:R ${p.riskReward.toFixed(2)}. ${p.stopRule}. ` +
    "Fiyat 1R kâra geçince stop girişe çekilir (sonra en kötü ihtimalle ücret kadar eksiyle kapanır).";
  if (p.tpAdjusted && p.resistance) note += ` Hedef, ${fmt(p.resistance)} ${long ? "direncinin hemen altına" : "desteğinin hemen üstüne"} çekildi.`;
  return { side: p.side, entry: p.entry, stopLoss: p.stopLoss, takeProfit: p.takeProfit, riskReward: p.riskReward, note };
}

function headline(v: Verdict, view: ConsensusView): string {
  switch (v) {
    case "STRONG_BUY":
      return "GÜÇLÜ AL — sinyal kapısının tüm kontrolleri ve A+ koşulları sağlandı";
    case "BUY":
      return "AL — sinyal kapısının tüm kontrolleri sağlandı";
    case "SELL":
    case "STRONG_SELL":
      return "SAT — sinyal kapısının tüm kontrolleri sağlandı";
    case "AVOID":
      return "UZAK DUR — koşulların çoğu aşağıyı gösteriyor, alım yapmayın";
    default: {
      const ok = view.checks.filter((c) => c.ok).length;
      return view.score >= 70
        ? `Güçlü görünüm ama sinyal yok — ${ok}/${view.checks.length} kontrol geçti`
        : "BEKLE — sinyal koşulları oluşmadı";
    }
  }
}

function volatilityLevel(atrPct: number, interval: Interval): "low" | "normal" | "high" {
  // Aralık uzadıkça mum başına normal hareket büyür
  const scale: Record<Interval, number> = { "1m": 0.15, "5m": 0.3, "15m": 0.5, "1h": 1, "4h": 2, "1d": 4.5 };
  const ref = scale[interval];
  if (atrPct > ref * 1.8) return "high";
  if (atrPct < ref * 0.45) return "low";
  return "normal";
}

function buildLevels(candles: Candle[], price: number, atrValue: number): PriceLevel[] {
  if (!Number.isFinite(atrValue) || price <= 0) return [];
  const raw = findLevels(candles, atrValue * 0.6, 3, 300);
  const supports = raw
    .filter((l) => l.price < price)
    .sort((a, b) => b.price - a.price)
    .slice(0, 3);
  const resistances = raw
    .filter((l) => l.price > price)
    .sort((a, b) => a.price - b.price)
    .slice(0, 3);
  const toLevel = (l: (typeof raw)[number], kind: PriceLevel["kind"]): PriceLevel => ({
    price: l.price,
    kind,
    touches: l.touches,
    distancePct: ((l.price - price) / price) * 100,
  });
  return [...resistances.reverse().map((l) => toLevel(l, "resistance")), ...supports.map((l) => toLevel(l, "support"))];
}

function explain(
  s: Snapshot,
  higherTrend: string | null,
  interval: Interval,
  levels: PriceLevel[],
  price: number,
  trend: Trend,
): AnalysisPoint[] {
  const points: AnalysisPoint[] = [];
  const tf = TF_TR[interval];

  // Trend (konsensüsle aynı tanım: YUKARI = EMA21 > EMA50 > EMA200 ve fiyat > EMA50)
  if (trend === "UP") {
    points.push({
      title: "Ana yön (trend)",
      tone: "bull",
      text: "Kısa, orta ve uzun vadeli ortalamalar yukarı dizilmiş (EMA21 > EMA50 > EMA200) ve fiyat EMA50'nin üstünde: genel yön YUKARI.",
    });
  } else if (trend === "DOWN") {
    points.push({
      title: "Ana yön (trend)",
      tone: "bear",
      text: "Ortalamalar aşağı dizilmiş (EMA21 < EMA50 < EMA200) ve fiyat EMA50'nin altında: genel yön AŞAĞI. Düşen bıçak tutulmaz.",
    });
  } else {
    points.push({
      title: "Ana yön (trend)",
      tone: "neutral",
      text: `Ortalamaların dizilimi net değil (EMA21 ${fmt(s.ema21)}, EMA50 ${fmt(s.ema50)}${Number.isFinite(s.ema200) ? `, EMA200 ${fmt(s.ema200)}` : ""}): trend YATAY.`,
    });
  }

  // Trend gücü
  if (Number.isFinite(s.adx)) {
    const dirTxt = s.plusDi > s.minusDi ? "alıcılar" : "satıcılar";
    points.push(
      s.adx >= 25
        ? {
            title: "Trend gücü (ADX)",
            tone: s.plusDi > s.minusDi ? "bull" : "bear",
            text: `ADX ${s.adx.toFixed(0)}: hareket güçlü ve kontrol ${dirTxt}nda. Güçlü trendde sinyaller daha güvenilirdir.`,
          }
        : s.adx >= 18
          ? {
              title: "Trend gücü (ADX)",
              tone: "neutral",
              text: `ADX ${s.adx.toFixed(0)}: trend orta güçte, ${dirTxt} hafif önde.`,
            }
          : {
              title: "Trend gücü (ADX)",
              tone: "neutral",
              text: `ADX ${s.adx.toFixed(0)}: piyasa yatay ve yönsüz. Bu dönemde sinyaller sık yanıltır — beklemek en iyisi.`,
            },
    );
  }

  // RSI
  if (Number.isFinite(s.rsi)) {
    const r = s.rsi;
    let p: AnalysisPoint;
    if (r >= 70) p = { title: "Momentum (RSI)", tone: "bear", text: `RSI ${r.toFixed(0)}: fiyat kısa sürede çok yükseldi (aşırı alım). Şimdi almak tepeden almak olabilir; bir geri çekilme gelebilir.` };
    else if (r <= 30) p = { title: "Momentum (RSI)", tone: "bull", text: `RSI ${r.toFixed(0)}: fiyat kısa sürede çok düştü (aşırı satım). Tepki yükselişi gelebilir ama trend aşağıysa düşüş sürebilir.` };
    else if (r >= 55) p = { title: "Momentum (RSI)", tone: "bull", text: `RSI ${r.toFixed(0)}: alıcılar baskın, ama henüz aşırı pahalı bölgede değil. Sağlıklı yükseliş görüntüsü.` };
    else if (r <= 45) p = { title: "Momentum (RSI)", tone: "bear", text: `RSI ${r.toFixed(0)}: satıcılar baskın, fiyat zayıf.` };
    else p = { title: "Momentum (RSI)", tone: "neutral", text: `RSI ${r.toFixed(0)}: alıcı ve satıcı dengede.` };
    points.push(p);
  }

  // MACD
  if (Number.isFinite(s.macdHist)) {
    const rising = s.macdHist > s.macdHistPrev;
    if (s.macd > s.macdSignal) {
      points.push({
        title: "Hız (MACD)",
        tone: "bull",
        text: rising ? "MACD yukarı ve hızlanıyor: yükseliş ivme kazanıyor." : "MACD hâlâ pozitif ama ivme azalıyor: yükseliş yorulabilir.",
      });
    } else {
      points.push({
        title: "Hız (MACD)",
        tone: "bear",
        text: rising ? "MACD negatif ama düşüş yavaşlıyor: satış baskısı azalıyor, dönüş için ilk işaret olabilir." : "MACD negatif ve düşüş hızlanıyor: satış baskısı artıyor.",
      });
    }
  }

  // Bollinger konumu
  if (Number.isFinite(s.bbUpper)) {
    const width = s.bbUpper - s.bbLower;
    const pos = width > 0 ? (s.close - s.bbLower) / width : 0.5;
    if (pos >= 0.95) points.push({ title: "Fiyat bandı (Bollinger)", tone: "bear", text: "Fiyat normal salınım bandının üst kenarında: kısa vadede pahalı bölge, kâr satışı gelebilir." });
    else if (pos <= 0.05) points.push({ title: "Fiyat bandı (Bollinger)", tone: "bull", text: "Fiyat normal salınım bandının alt kenarında: kısa vadede ucuz bölge, tepki gelebilir." });
    else if (pos > 0.5) points.push({ title: "Fiyat bandı (Bollinger)", tone: "bull", text: "Fiyat bandın üst yarısında: alıcılar kontrolde." });
    else points.push({ title: "Fiyat bandı (Bollinger)", tone: "bear", text: "Fiyat bandın alt yarısında: satıcılar kontrolde." });
  }

  // Hacim
  if (Number.isFinite(s.volumeRatio)) {
    if (s.volumeRatio >= 1.5) points.push({ title: "Hacim", tone: s.close >= s.ema9 ? "bull" : "bear", text: `Son mumda işlem hacmi ortalamanın ${s.volumeRatio.toFixed(1)} katı: hareketin arkasında gerçek para var.` });
    else if (s.volumeRatio <= 0.6) points.push({ title: "Hacim", tone: "neutral", text: "İşlem hacmi düşük: piyasa ilgisiz, hareketler zayıf kalabilir." });
  }

  // Üst zaman dilimi
  if (higherTrend) {
    points.push({
      title: "Büyük resim",
      tone: higherTrend === "UP" ? "bull" : higherTrend === "DOWN" ? "bear" : "neutral",
      text:
        higherTrend === "UP"
          ? `Bir üst zaman dilimi de yukarı yönlü: ${tf} grafikteki alımlar büyük trendle aynı yönde.`
          : higherTrend === "DOWN"
            ? `Bir üst zaman dilimi aşağı yönlü: ${tf} grafikteki yükselişler kısa süreli tepki olabilir.`
            : "Bir üst zaman diliminde yön belirsiz.",
    });
  }

  // Destek / direnç
  const sup = levels.find((l) => l.kind === "support");
  const res = levels.find((l) => l.kind === "resistance");
  if (sup || res) {
    const parts: string[] = [];
    if (sup) parts.push(`En yakın destek (taban) ${fmt(sup.price)} — %${Math.abs(sup.distancePct).toFixed(2)} aşağıda. Fiyat düşerse burada alıcı bulabilir.`);
    if (res) parts.push(`En yakın direnç (tavan) ${fmt(res.price)} — %${res.distancePct.toFixed(2)} yukarıda. Yükselişte burada satış gelebilir.`);
    const nearRes = res && res.distancePct < 0.6;
    const nearSup = sup && Math.abs(sup.distancePct) < 0.6;
    points.push({
      title: "Destek ve direnç",
      tone: nearRes ? "bear" : nearSup ? "bull" : "neutral",
      text: parts.join(" ") + (nearRes ? " Fiyat dirence çok yakın — almak için kırılmasını beklemek daha güvenli." : nearSup ? " Fiyat desteğe çok yakın — risk/ödül açısından iyi bir alım bölgesi olabilir." : ""),
    });
  }
  void price;
  return points;
}

function summarize(v: Verdict, tfs: TimeframeView[], s: Snapshot | null, view: ConsensusView): string {
  if (!s) return "Bu coin için yeterli geçmiş veri yok.";
  const up = tfs.filter((t) => t.trend === "UP").map((t) => TF_TR[t.interval]);
  const down = tfs.filter((t) => t.trend === "DOWN").map((t) => TF_TR[t.interval]);
  const flat = tfs.filter((t) => t.trend === "NEUTRAL").map((t) => TF_TR[t.interval]);
  const parts: string[] = [];
  if (tfs.length && up.length === tfs.length) parts.push("Tüm zaman dilimlerinde yön yukarı.");
  else if (tfs.length && down.length === tfs.length) parts.push("Tüm zaman dilimlerinde yön aşağı.");
  else {
    const seg: string[] = [];
    if (up.length) seg.push(`${up.join(", ")} grafikte yön yukarı`);
    if (down.length) seg.push(`${down.join(", ")} grafikte yön aşağı`);
    if (flat.length) seg.push(`${flat.join(", ")} grafikte yön belirsiz`);
    if (seg.length) parts.push(`${seg.join("; ")}.`);
  }
  const ok = view.checks.filter((c) => c.ok).length;
  if (v === "STRONG_BUY" || v === "BUY") {
    parts.push(`Sinyal kapısının ${view.checks.length} kontrolünün hepsi geçti; aşağıdaki planı ve stop seviyesini kullanın.`);
  } else if (v === "AVOID") {
    parts.push("Alım için uygun değil. Trendin dönmesini bekleyin.");
  } else {
    parts.push(`Sinyal yok: ${ok}/${view.checks.length} kontrol geçti${view.blockedBy ? ` — ${view.blockedBy.toLowerCase()}` : ""}.`);
  }
  return parts.join(" ");
}

function fmt(n: number): string {
  const d = n >= 1000 ? 2 : n >= 10 ? 3 : n >= 1 ? 4 : 6;
  return n.toLocaleString("tr-TR", { minimumFractionDigits: d, maximumFractionDigits: d });
}
