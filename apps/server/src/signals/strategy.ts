import {
  adx,
  atr,
  bollinger,
  ema,
  macd,
  rsi,
  sma,
  type Candle,
  type PositionSide,
  type Trend,
} from "@signal-lab/shared";

export interface StrategyParams {
  minScore: number;
  /** Yapısal stop bulunamazsa / sınır için ATR çarpanı */
  atrStopMultiplier: number;
  /** Sinyal için en düşük ADX; 0 = kapalı */
  minAdx: number;
  /** Üst zaman dilimi trendi aynı yönde olmalı */
  requireHigherTimeframe: boolean;
  /** Hedef / risk oranı */
  riskReward: number;
  /** SHORT sinyallerine izin ver (geçmiş testlerde zararda olduğu için varsayılan kapalı) */
  allowShort: boolean;
}

export interface StrategySignal {
  side: PositionSide;
  score: number;
  strength: number;
  /** Strateji içi güven (0-100); motor geçmiş başarıyla harmanlar */
  confidence: number;
  reasons: string[];
  stopLoss: number;
  takeProfit: number;
  riskReward: number;
}

export interface Snapshot {
  close: number;
  ema9: number;
  ema21: number;
  ema50: number;
  ema200: number;
  rsi: number;
  rsiPrev: number;
  macd: number;
  macdSignal: number;
  macdHist: number;
  macdHistPrev: number;
  bbUpper: number;
  bbLower: number;
  bbMiddle: number;
  atr: number;
  adx: number;
  plusDi: number;
  minusDi: number;
  volumeRatio: number;
}

export interface StrategyResult {
  trend: Trend;
  rsi: number | null;
  /** -10..+10 */
  score: number;
  snapshot: Snapshot | null;
  /** Yönü destekleyen/karşı çıkan bileşenler (teknik analiz metni için) */
  bull: Component[];
  bear: Component[];
  higherTrend: Trend | null;
  signal: StrategySignal | null;
  /** Sinyal çıkmadıysa sebebi (hata ayıklama / analiz için) */
  blockedBy: string | null;
}

export interface Component {
  points: number;
  reason: string;
  /** Kesişim/dönüş gibi anlık tetikleyici mi? */
  trigger?: boolean;
}

export const MIN_CANDLES = 60;

export const DEFAULT_PARAMS: StrategyParams = {
  minScore: 4,
  atrStopMultiplier: 1.5,
  minAdx: 20,
  requireHigherTimeframe: true,
  riskReward: 1.5,
  allowShort: false,
};

/** Üst zaman dilimi için basit trend tespiti (EMA21/50 dizilimi + fiyat konumu). */
export function trendOf(candles: Candle[]): Trend {
  if (candles.length < 55) return "NEUTRAL";
  const closes = candles.map((c) => c.close);
  const i = closes.length - 1;
  const e21 = ema(closes, 21)[i];
  const e50 = ema(closes, 50)[i];
  const close = closes[i];
  if (close > e50 && e21 > e50) return "UP";
  if (close < e50 && e21 < e50) return "DOWN";
  return "NEUTRAL";
}

/**
 * Çoklu gösterge uyumu (confluence) stratejisi. Son KAPANMIŞ mum üzerinde değerlendirir.
 *
 * Puanlanan bileşenler: EMA50/200 trend yapısı, EMA9/21 kesişimi, MACD kesişimi, RSI aşırı bölge
 * dönüşleri, Bollinger dönüşleri, trend içi geri çekilme ve hacim teyidi.
 *
 * Sinyal için hepsi gerekir: tetikleyici olay + eşik üzerinde skor + ADX ile yeterli trend gücü
 * (ve DI yönü uyumlu) + üst zaman dilimi trendiyle uyum + RSI aşırı uçta değil.
 * Stop, son 8 mumun dibi/tepesinin biraz ötesine (1-2.5 ATR arası) konur; hedef = risk × R.
 */
export function evaluate(candles: Candle[], params: StrategyParams, higher?: Candle[]): StrategyResult {
  const empty: StrategyResult = {
    trend: "NEUTRAL",
    rsi: null,
    score: 0,
    snapshot: null,
    bull: [],
    bear: [],
    higherTrend: null,
    signal: null,
    blockedBy: "Yetersiz veri",
  };
  if (candles.length < MIN_CANDLES) return empty;

  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume);
  const i = candles.length - 1;
  const p = i - 1;
  const close = closes[i];

  const ema9 = ema(closes, 9);
  const ema21 = ema(closes, 21);
  const ema50 = ema(closes, 50);
  const ema200 = ema(closes, 200);
  const rsiValues = rsi(closes, 14);
  const m = macd(closes);
  const bb = bollinger(closes, 20, 2);
  const atrValues = atr(candles, 14);
  const dmi = adx(candles, 14);
  const volSma = sma(volumes, 20);

  const bull: Component[] = [];
  const bear: Component[] = [];
  const add = (points: number, reason: string, trigger = false) =>
    (points > 0 ? bull : bear).push({ points: Math.abs(points), reason, trigger });

  // 1) Trend yapısı
  let trend: Trend = "NEUTRAL";
  const hasLongTrend = Number.isFinite(ema200[i]);
  const slowRef = hasLongTrend ? ema200[i] : ema50[i];
  if (Number.isFinite(slowRef)) {
    if (close > slowRef && ema21[i] > ema50[i] && (!hasLongTrend || ema50[i] > ema200[i])) {
      trend = "UP";
      add(2, hasLongTrend ? "Yükseliş trendi (fiyat > EMA200, EMA50 > EMA200)" : "Yükseliş trendi (EMA21 > EMA50)");
    } else if (close < slowRef && ema21[i] < ema50[i] && (!hasLongTrend || ema50[i] < ema200[i])) {
      trend = "DOWN";
      add(-2, hasLongTrend ? "Düşüş trendi (fiyat < EMA200, EMA50 < EMA200)" : "Düşüş trendi (EMA21 < EMA50)");
    } else if (close > slowRef) {
      add(1, `Fiyat ${hasLongTrend ? "EMA200" : "EMA50"} üzerinde`);
    } else {
      add(-1, `Fiyat ${hasLongTrend ? "EMA200" : "EMA50"} altında`);
    }
  }

  // 2) EMA 9/21 kesişimi
  if (ema9[p] <= ema21[p] && ema9[i] > ema21[i]) add(2, "EMA9, EMA21'i yukarı kesti", true);
  else if (ema9[p] >= ema21[p] && ema9[i] < ema21[i]) add(-2, "EMA9, EMA21'i aşağı kesti", true);
  else if (ema9[i] > ema21[i]) add(0.5, "EMA9 > EMA21");
  else add(-0.5, "EMA9 < EMA21");

  // 3) MACD
  const ml = m.macd;
  const ms = m.signal;
  if (Number.isFinite(ms[p])) {
    if (ml[p] <= ms[p] && ml[i] > ms[i]) {
      add(ml[i] < 0 ? 2.5 : 2, `MACD al kesişimi${ml[i] < 0 ? " (sıfır altında, erken)" : ""}`, true);
    } else if (ml[p] >= ms[p] && ml[i] < ms[i]) {
      add(ml[i] > 0 ? -2.5 : -2, `MACD sat kesişimi${ml[i] > 0 ? " (sıfır üstünde, erken)" : ""}`, true);
    } else if (m.histogram[i] > 0) {
      add(0.5, "MACD histogramı pozitif");
    } else {
      add(-0.5, "MACD histogramı negatif");
    }
  }

  // 4) RSI
  const r = rsiValues[i];
  const rPrev = rsiValues[p];
  if (Number.isFinite(r)) {
    if (rPrev < 30 && r >= 30) add(2, `RSI aşırı satımdan çıktı (${r.toFixed(1)})`, true);
    else if (rPrev > 70 && r <= 70) add(-2, `RSI aşırı alımdan döndü (${r.toFixed(1)})`, true);
    else if (r < 25) add(1, `RSI aşırı satım bölgesinde (${r.toFixed(1)})`);
    else if (r > 75) add(-1, `RSI aşırı alım bölgesinde (${r.toFixed(1)})`);
    else if (r > 50) add(0.5, `RSI 50 üzerinde (${r.toFixed(1)})`);
    else add(-0.5, `RSI 50 altında (${r.toFixed(1)})`);
  }

  // 5) Bollinger bandı dönüşleri
  if (Number.isFinite(bb.lower[p])) {
    if (closes[p] < bb.lower[p] && close > bb.lower[i]) add(1.5, "Bollinger alt bandından geri dönüş", true);
    else if (closes[p] > bb.upper[p] && close < bb.upper[i]) add(-1.5, "Bollinger üst bandından geri dönüş", true);
  }

  // 6) Trend içi geri çekilme: son 4 mumda EMA21'e dokunup trend yönünde güçlü kapanış
  const bullishCandle = close > candles[i].open && close > ema9[i];
  const bearishCandle = close < candles[i].open && close < ema9[i];
  let touchedFromAbove = false;
  let touchedFromBelow = false;
  for (let k = Math.max(0, i - 3); k <= i; k++) {
    if (candles[k].low <= ema21[k] * 1.002) touchedFromAbove = true;
    if (candles[k].high >= ema21[k] * 0.998) touchedFromBelow = true;
  }
  if (close > ema50[i] && ema21[i] > ema50[i] && touchedFromAbove && bullishCandle && r > 42 && r < 68 && r > rPrev) {
    add(2, "Yükseliş trendinde EMA21'e geri çekilme sonrası alıcılar geri döndü", true);
  } else if (
    close < ema50[i] &&
    ema21[i] < ema50[i] &&
    touchedFromBelow &&
    bearishCandle &&
    r < 58 &&
    r > 32 &&
    r < rPrev
  ) {
    add(-2, "Düşüş trendinde EMA21'e tepki sonrası satıcılar geri döndü", true);
  }

  // 7) Üst zaman dilimi
  const higherTrend = higher && higher.length >= 55 ? trendOf(higher) : null;
  if (higherTrend === "UP") add(1.5, "Üst zaman dilimi de yükseliş trendinde");
  else if (higherTrend === "DOWN") add(-1.5, "Üst zaman dilimi de düşüş trendinde");

  const bullScore = sum(bull);
  const bearScore = sum(bear);
  let net = bullScore - bearScore;

  // 8) Hacim teyidi
  const volRatio = volSma[i] > 0 ? volumes[i] / volSma[i] : 1;
  const volumeConfirmed = volRatio >= 1.5;
  if (volumeConfirmed) net *= 1.2;

  const a = atrValues[i];
  const adxNow = dmi.adx[i];
  const snapshot: Snapshot = {
    close,
    ema9: ema9[i],
    ema21: ema21[i],
    ema50: ema50[i],
    ema200: ema200[i],
    rsi: r,
    rsiPrev: rPrev,
    macd: ml[i],
    macdSignal: ms[i],
    macdHist: m.histogram[i],
    macdHistPrev: m.histogram[p],
    bbUpper: bb.upper[i],
    bbLower: bb.lower[i],
    bbMiddle: bb.middle[i],
    atr: a,
    adx: adxNow,
    plusDi: dmi.plusDi[i],
    minusDi: dmi.minusDi[i],
    volumeRatio: volRatio,
  };

  const score = round(clamp(net, -10, 10), 2);
  const result: StrategyResult = {
    trend,
    rsi: Number.isFinite(r) ? round(r, 2) : null,
    score,
    snapshot,
    bull,
    bear,
    higherTrend,
    signal: null,
    blockedBy: null,
  };
  const block = (why: string) => ((result.blockedBy = why), result);

  const side: PositionSide | null = net > 0 ? "LONG" : net < 0 ? "SHORT" : null;
  if (!side) return block("Göstergeler kararsız");
  const long = side === "LONG";
  if (!long && !params.allowShort) return block("Short sinyalleri kapalı (geçmiş testte zararda)");
  const aligned = long ? bull : bear;
  if (!aligned.some((c) => c.trigger)) return block("Tetikleyici olay yok");
  if (Math.abs(net) < params.minScore) return block("Skor eşiğin altında");
  if (long && r > 72) return block("RSI aşırı alımda, geç kalınmış");
  if (!long && r < 28) return block("RSI aşırı satımda, geç kalınmış");
  if (params.minAdx > 0) {
    if (!(adxNow >= params.minAdx)) return block("Trend gücü (ADX) zayıf, piyasa yatay");
    const diOk = long ? dmi.plusDi[i] > dmi.minusDi[i] : dmi.minusDi[i] > dmi.plusDi[i];
    if (!diOk) return block("Yön baskısı (DI) sinyalle uyumsuz");
  }
  if (params.requireHigherTimeframe && higherTrend !== null && higherTrend !== (long ? "UP" : "DOWN")) {
    return block("Üst zaman dilimi trendi uyumsuz");
  }
  if (!Number.isFinite(a) || a <= 0) return block("ATR hesaplanamadı");

  // Yapısal stop: son 8 mumun dibi/tepesi + 0.25 ATR pay, 1 ile maks ATR arasında sınırlı
  const from = Math.max(0, i - 7);
  const swing = long
    ? Math.min(...candles.slice(from, i + 1).map((c) => c.low))
    : Math.max(...candles.slice(from, i + 1).map((c) => c.high));
  const dir = long ? 1 : -1;
  let risk = Math.abs(close - (swing - dir * 0.25 * a));
  risk = clamp(risk, a, a * Math.max(params.atrStopMultiplier, 1.5) + a);
  const stopLoss = close - dir * risk;
  const takeProfit = close + dir * risk * params.riskReward;

  const reasons = aligned.map((c) => c.reason);
  if (volumeConfirmed) reasons.push(`Hacim ortalamanın ${volRatio.toFixed(1)} katı`);

  const absNet = Math.abs(net);
  const confidence = clamp(
    Math.round(absNet * 5 + Math.max(0, (adxNow || 0) - 15) * 1.2 + (higherTrend ? 15 : 0) + (volumeConfirmed ? 5 : 0)),
    0,
    100,
  );

  result.signal = {
    side,
    score: round(absNet, 2),
    strength: Math.min(100, Math.round((absNet / 10) * 100)),
    confidence,
    reasons,
    stopLoss,
    takeProfit,
    riskReward: params.riskReward,
  };
  return result;
}

function sum(components: Component[]): number {
  return components.reduce((acc, c) => acc + c.points, 0);
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

function round(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
