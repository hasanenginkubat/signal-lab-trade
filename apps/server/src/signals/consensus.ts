import {
  adx,
  atr,
  ema,
  macd,
  rsi,
  sma,
  type Candle,
  type GateCheck,
  type PositionSide,
  type SignalPlan,
  type SignalQuality,
  type Trend,
} from "@signal-lab/shared";
import { DEFAULT_PARAMS, evaluate, trendOf, type StrategyParams } from "./strategy";

const DAY = 86_400_000;
const WEEK = 7 * DAY;

/** Binance gün/hafta başlangıcı (UTC 00:00; hafta pazartesi). TR saatiyle 03:00. */
export const dayStart = (t: number) => Math.floor(t / DAY) * DAY;
export const weekStart = (t: number) => Math.floor((t - 4 * DAY) / WEEK) * WEEK + 4 * DAY;

export interface ConsensusInput {
  /** Sinyal aralığı (1s) kapanmış mumlar */
  h1: Candle[];
  m15: Candle[];
  h4: Candle[];
  d1: Candle[];
  /** Piyasa yönü için BTC 4s mumları (BTC'nin kendisi için h4 kullanılır) */
  btc4h?: Candle[];
  /** Piyasa rejimi için BTC günlük mumları (BTC'nin kendisi için d1 kullanılır) */
  btc1d?: Candle[];
}

export interface Vote {
  key: string;
  /** Kısa başlık (ör. "Haftalık trend") */
  label: string;
  /** +1 al, −1 sat, 0 nötr */
  vote: -1 | 0 | 1;
  /** Skora katkı (−1…+1) */
  value: number;
  weight: number;
  /** Sade dille açıklama */
  detail: string;
  /** Anlık tetikleyici strateji mi (kırılım, kesişim…) */
  trigger?: boolean;
  parts?: { label: string; vote: -1 | 0 | 1 }[];
}

export interface ConsensusParams {
  /** Sinyal için gereken en düşük konsensüs (%) */
  threshold: number;
  /** Kapı: ADX bunun altındaysa sinyal ve plan yok */
  minAdx: number;
  /** A+ için gereken ADX */
  aPlusMinAdx: number;
  /** Hedef = giriş + riskReward × risk */
  riskReward: number;
  allowShort: boolean;
  strategy: StrategyParams;
}

export const DEFAULT_CONSENSUS_PARAMS: ConsensusParams = {
  threshold: 70,
  minAdx: 18,
  aPlusMinAdx: 25,
  riskReward: 1.5,
  allowShort: false,
  strategy: DEFAULT_PARAMS,
};

/** Uygulama yapılandırmasından konsensüs parametreleri (tek kaynak) */
export function consensusParamsFrom(cfg: {
  consensus: { threshold: number; minAdx: number; aPlusMinAdx: number };
  strategy: StrategyParams & { riskReward: number; allowShort: boolean };
}): ConsensusParams {
  return {
    threshold: cfg.consensus.threshold,
    minAdx: cfg.consensus.minAdx,
    aPlusMinAdx: cfg.consensus.aPlusMinAdx,
    riskReward: cfg.strategy.riskReward,
    allowShort: cfg.strategy.allowShort,
    strategy: cfg.strategy,
  };
}

export interface ConsensusSignal {
  side: PositionSide;
  /** A+ kalite */
  strong: boolean;
  quality: SignalQuality;
  qualityNotes: string[];
  /** Sinyal mumundaki ATR (akıllı giriş için) */
  atr: number;
  stopLoss: number;
  takeProfit: number;
  riskReward: number;
  plan: SignalPlan;
}

export interface ConsensusResult {
  /** −100 (tüm koşullar SAT) … +100 (tüm koşullar AL) */
  score: number;
  votes: Vote[];
  /** Baskın yönü destekleyen koşul sayısı */
  agree: number;
  total: number;
  /** agree / total (%) */
  confidence: number;
  side: PositionSide | null;
  /** Sinyal kapısı: tüm kontroller; AL yalnızca passed=true iken */
  gate: { passed: boolean; checks: GateCheck[]; blockedBy: string | null };
  /** Kapı geçildiyse sinyal, değilse null */
  signal: ConsensusSignal | null;
  blockedBy: string | null;
  levels: { dayOpen: number | null; weekOpen: number | null; vwap: number | null };
  btcTrend: Trend | null;
  btcDailyTrend: Trend | null;
  adx: number | null;
  rsi: number | null;
  atr: number | null;
}

/** Günlük mumlardan haftalık mum üretir. */
export function toWeekly(d1: Candle[]): Candle[] {
  const out: Candle[] = [];
  for (const c of d1) {
    const ws = weekStart(c.openTime);
    const last = out[out.length - 1];
    if (last && last.openTime === ws) {
      last.high = Math.max(last.high, c.high);
      last.low = Math.min(last.low, c.low);
      last.close = c.close;
      last.volume += c.volume;
      last.closeTime = c.closeTime;
    } else {
      out.push({ ...c, interval: "1w", openTime: ws });
    }
  }
  return out;
}

function weeklyTrend(d1: Candle[]): Trend {
  const w = toWeekly(d1);
  if (w.length < 12) return "NEUTRAL";
  const closes = w.map((c) => c.close);
  const e10 = ema(closes, 10);
  const i = closes.length - 1;
  if (closes[i] > e10[i] && e10[i] >= e10[i - 1]) return "UP";
  if (closes[i] < e10[i] && e10[i] <= e10[i - 1]) return "DOWN";
  return "NEUTRAL";
}

const trendVote = (t: Trend): -1 | 0 | 1 => (t === "UP" ? 1 : t === "DOWN" ? -1 : 0);
const sign = (v: number): -1 | 0 | 1 => (v > 0 ? 1 : v < 0 ? -1 : 0);
const TREND_TR: Record<Trend, string> = { UP: "yukarı", DOWN: "aşağı", NEUTRAL: "yatay" };

/**
 * Tüm analizleri tek kararda birleştirir. Her koşul ağırlıklı oy verir:
 *  - Zaman dilimleri: haftalık, günlük, 4s, 1s, 15dk trendleri
 *  - Gün içi seviyeler: gün açılışı, hafta açılışı, günlük VWAP
 *  - Stratejiler: trend devamı (ana strateji), kırılım (20 mum), momentum (MACD+RSI)
 * Sinyal KAPISI: konsensüs eşiği, tetikleyici strateji, ADX ≥ minAdx, RSI aşırı değil.
 * Plan (sinyal mumunun kapanışından): stop = son 8 mumun dibi − 0.25×ATR (1–2.5 ATR arası),
 * hedef = giriş + R × risk.
 */
export function evaluateConsensus(input: ConsensusInput, p: ConsensusParams): ConsensusResult {
  const { h1, m15, h4, d1 } = input;
  const empty: ConsensusResult = {
    score: 0,
    votes: [],
    agree: 0,
    total: 0,
    confidence: 0,
    side: null,
    gate: { passed: false, checks: [], blockedBy: "Yetersiz veri" },
    signal: null,
    blockedBy: "Yetersiz veri",
    levels: { dayOpen: null, weekOpen: null, vwap: null },
    btcTrend: null,
    btcDailyTrend: null,
    adx: null,
    rsi: null,
    atr: null,
  };
  if (h1.length < 60) return empty;

  const i = h1.length - 1;
  const last = h1[i];
  const price = last.close;
  const now = last.closeTime + 1;
  const votes: Vote[] = [];
  const push = (v: Omit<Vote, "value">) => votes.push({ ...v, value: v.vote });

  // --- Zaman dilimi trendleri ---
  const wT = weeklyTrend(d1);
  push({ key: "weekly", label: "Haftalık trend", vote: trendVote(wT), weight: 1.5, detail: `Haftalık grafikte yön ${TREND_TR[wT]}` });
  const dT = d1.length >= 55 ? trendOf(d1) : "NEUTRAL";
  push({ key: "daily", label: "Günlük trend", vote: trendVote(dT), weight: 1.5, detail: `Günlük grafikte yön ${TREND_TR[dT]}` });
  const h4T = h4.length >= 55 ? trendOf(h4) : "NEUTRAL";
  push({ key: "h4", label: "4 saatlik trend", vote: trendVote(h4T), weight: 1, detail: `4 saatlik grafikte yön ${TREND_TR[h4T]}` });
  const h1T = trendOf(h1);
  push({ key: "h1", label: "1 saatlik trend", vote: trendVote(h1T), weight: 1, detail: `1 saatlik grafikte yön ${TREND_TR[h1T]}` });
  // 15dk verisi yoksa (eski dönem testleri) oy hiç sayılmaz; nötr sayıp skoru düşürmez
  if (m15.length >= 55) {
    const r = rsi(m15.map((c) => c.close), 14);
    const t = trendOf(m15);
    const rv = r[r.length - 1];
    const m15Vote: -1 | 0 | 1 = t === "UP" && rv > 50 ? 1 : t === "DOWN" && rv < 50 ? -1 : 0;
    push({ key: "m15", label: "15dk momentum", vote: m15Vote, weight: 0.5, detail: m15Vote > 0 ? "Kısa vadede alıcılar önde" : m15Vote < 0 ? "Kısa vadede satıcılar önde" : "Kısa vadede kararsız" });
  }

  // --- Gün/hafta açılışı ve VWAP ---
  const ds = dayStart(now - 1);
  const ws = weekStart(now - 1);
  const dayCandles = h1.filter((c) => c.openTime >= ds);
  const dayOpen = dayCandles[0]?.open ?? null;
  const weekOpen = h1.find((c) => c.openTime >= ws)?.open ?? null;
  let vwap: number | null = null;
  if (dayCandles.length) {
    let pv = 0;
    let vol = 0;
    for (const c of dayCandles) {
      pv += ((c.high + c.low + c.close) / 3) * c.volume;
      vol += c.volume;
    }
    vwap = vol > 0 ? pv / vol : null;
  }
  if (dayOpen) {
    const pct = ((price - dayOpen) / dayOpen) * 100;
    push({ key: "dayOpen", label: "Gün açılışı", vote: sign(pct), weight: 0.75, detail: `Gün ${fmt(dayOpen)} seviyesinden açıldı, fiyat şimdi açılışın %${Math.abs(pct).toFixed(2)} ${pct >= 0 ? "üstünde" : "altında"}` });
  }
  if (weekOpen) {
    const pct = ((price - weekOpen) / weekOpen) * 100;
    push({ key: "weekOpen", label: "Hafta açılışı", vote: sign(pct), weight: 0.75, detail: `Hafta ${fmt(weekOpen)} seviyesinden açıldı, fiyat %${Math.abs(pct).toFixed(2)} ${pct >= 0 ? "üstünde" : "altında"}` });
  }
  if (vwap) {
    push({ key: "vwap", label: "Günlük ortalama fiyat (VWAP)", vote: sign(price - vwap), weight: 0.75, detail: price >= vwap ? "Fiyat bugün işlem görenlerin ortalama maliyetinin üstünde: alıcılar kârda" : "Fiyat bugünkü ortalama maliyetin altında: alıcılar zararda" });
  }

  // --- Stratejiler ---
  const main = evaluate(h1, p.strategy, h4.length ? h4 : undefined);
  const mainVote: -1 | 0 | 1 = main.signal ? (main.signal.side === "LONG" ? 1 : -1) : sign(Math.abs(main.score) >= 3 ? main.score : 0);
  push({
    key: "trendStrategy",
    label: "Strateji: trend devamı",
    vote: mainVote,
    weight: main.signal ? 2 : 1,
    trigger: !!main.signal,
    detail: main.signal ? `Tetiklendi: ${main.signal.reasons[main.signal.reasons.length - 1] ?? ""}` : `Skor ${main.score.toFixed(1)} — ${main.blockedBy ?? "bekliyor"}`,
  });

  const highs = h1.map((c) => c.high);
  const lows = h1.map((c) => c.low);
  const prevHigh = Math.max(...highs.slice(i - 20, i));
  const prevLow = Math.min(...lows.slice(i - 20, i));
  const volSma = sma(h1.map((c) => c.volume), 20);
  const volOk = last.volume > volSma[i] * 1.2;
  const breakout: -1 | 0 | 1 = price > prevHigh && volOk ? 1 : price < prevLow && volOk ? -1 : 0;
  push({
    key: "breakout",
    label: "Strateji: kırılım",
    vote: breakout,
    weight: 1.5,
    trigger: breakout !== 0,
    detail: breakout > 0 ? `Fiyat son 20 mumun zirvesini (${fmt(prevHigh)}) hacimle kırdı` : breakout < 0 ? `Fiyat son 20 mumun dibini (${fmt(prevLow)}) hacimle kırdı` : `Kırılım yok (aralık ${fmt(prevLow)} – ${fmt(prevHigh)})`,
  });

  const closes = h1.map((c) => c.close);
  const m = macd(closes);
  const r1 = rsi(closes, 14);
  let crossUp = false;
  let crossDown = false;
  for (let k = i - 2; k <= i; k++) {
    if (m.macd[k - 1] <= m.signal[k - 1] && m.macd[k] > m.signal[k]) crossUp = true;
    if (m.macd[k - 1] >= m.signal[k - 1] && m.macd[k] < m.signal[k]) crossDown = true;
  }
  const histUp = m.histogram[i] > m.histogram[i - 1];
  const momentum: -1 | 0 | 1 =
    crossUp && histUp && r1[i] > 50 && r1[i] < 70 ? 1 : crossDown && !histUp && r1[i] < 50 && r1[i] > 30 ? -1 : 0;
  push({
    key: "momentum",
    label: "Strateji: momentum",
    vote: momentum,
    weight: 1,
    trigger: momentum !== 0,
    detail: momentum > 0 ? "MACD yukarı kesti ve hızlanıyor, RSI sağlıklı bölgede" : momentum < 0 ? "MACD aşağı kesti ve hızlanıyor" : `Momentum tetikleyicisi yok (RSI ${r1[i].toFixed(0)})`,
  });

  // --- Birleştir ---
  const totalW = votes.reduce((a, v) => a + v.weight, 0);
  const net = votes.reduce((a, v) => a + v.value * v.weight, 0);
  const score = totalW ? Math.round((net / totalW) * 100) : 0;
  const side: PositionSide | null = score > 0 ? "LONG" : score < 0 ? "SHORT" : null;
  const dir = side === "SHORT" ? -1 : 1;
  const agree = side ? votes.filter((v) => v.vote === dir).length : 0;
  const btcSrc = input.btc4h ?? h4;
  const btcTrend: Trend | null = btcSrc.length >= 55 ? trendOf(btcSrc) : null;
  const btcDailySrc = input.btc1d ?? d1;
  const btcDailyTrend: Trend | null = btcDailySrc.length >= 55 ? trendOf(btcDailySrc) : null;
  const a = atr(h1, 14)[i];
  const adxNow = adx(h1, 14).adx[i];
  const rNow = r1[i];

  // --- Sinyal kapısı (eski kurallar; her kontrol ayrı ve görünür) ---
  const checks: GateCheck[] = [];
  const check = (key: string, label: string, ok: boolean, detail: string) => checks.push({ key, label, ok, detail });
  const dirAllowed = side === "LONG" || (side === "SHORT" && p.allowShort);
  check(
    "consensus",
    `Konsensüs ≥ %${p.threshold}`,
    !!side && dirAllowed && Math.abs(score) >= p.threshold,
    !side ? "Koşullar dengede" : !dirAllowed ? `Koşullar aşağı yönlü (%${score}) — short işlemler kapalı` : `Konsensüs %${Math.abs(score)} (${agree}/${votes.length} koşul)`,
  );
  const triggers = votes.filter((v) => v.trigger && v.vote === dir);
  check("trigger", "Tetikleyici strateji", triggers.length > 0, triggers.length ? triggers.map((t) => t.label.replace("Strateji: ", "")).join(" + ") : "Hiçbir strateji tetiklenmedi");
  check("adx", `Trend gücü ADX ≥ ${p.minAdx}`, p.minAdx <= 0 || adxNow >= p.minAdx, Number.isFinite(adxNow) ? `ADX ${adxNow.toFixed(1)}` : "ADX hesaplanamadı");
  check(
    "rsi",
    side === "SHORT" ? "RSI aşırı satımda değil" : "RSI aşırı alımda değil",
    side === "SHORT" ? rNow >= 25 : rNow <= 75,
    `RSI ${Number.isFinite(rNow) ? rNow.toFixed(1) : "—"}`,
  );
  check("atr", "ATR hesaplanabilir", Number.isFinite(a) && a > 0, Number.isFinite(a) ? `ATR ${fmt(a)}` : "ATR yok");

  const failed = checks.find((c) => !c.ok);
  const passed = !failed;
  const blockedBy = failed ? `${failed.label}: ${failed.detail}` : null;
  const result: ConsensusResult = {
    score,
    votes,
    agree,
    total: votes.length,
    confidence: votes.length ? Math.round((agree / votes.length) * 100) : 0,
    side,
    gate: { passed, checks, blockedBy },
    signal: null,
    blockedBy,
    levels: { dayOpen, weekOpen, vwap },
    btcTrend,
    btcDailyTrend,
    adx: Number.isFinite(adxNow) ? adxNow : null,
    rsi: Number.isFinite(rNow) ? rNow : null,
    atr: Number.isFinite(a) ? a : null,
  };
  if (!passed || !side) return result;

  const plan = computePlan(h1, side, a, p);
  // A+ kalite (eski kural; rejim koşulu BTC günlük trendOf = YUKARI)
  const breakoutOrMulti = triggers.some((v) => v.key === "breakout") || triggers.length >= 2;
  const strongTrend = adxNow >= p.aPlusMinAdx;
  const marketOk = btcTrend !== (side === "LONG" ? "DOWN" : "UP");
  const regimeOk = btcDailyTrend === (side === "LONG" ? "UP" : "DOWN");
  const aPlus = breakoutOrMulti && strongTrend && marketOk && regimeOk;
  const qualityNotes = [
    breakoutOrMulti ? (triggers.length >= 2 ? `${triggers.length} strateji aynı anda tetiklendi` : "Fiyat kırılım yaptı") : "Tek strateji tetiklendi (kırılım yok)",
    strongTrend ? `Trend güçlü (ADX ${adxNow.toFixed(0)})` : `Trend orta (ADX ${adxNow.toFixed(0)} < ${p.aPlusMinAdx})`,
    marketOk ? "BTC (piyasa) aleyhte değil" : "BTC 4 saatlikte ters yönde — piyasa aleyhte",
    regimeOk ? "Piyasa rejimi uygun (BTC günlükte yükselişte)" : `Piyasa rejimi uygun değil (BTC günlük trendi ${btcDailyTrend ? TREND_TR[btcDailyTrend] : "belirsiz"})`,
  ];
  result.signal = {
    side,
    strong: aPlus,
    quality: aPlus ? "A+" : "A",
    qualityNotes,
    atr: a,
    stopLoss: plan.stopLoss,
    takeProfit: plan.takeProfit,
    riskReward: plan.riskReward,
    plan,
  };
  return result;
}

/**
 * İşlem planı (eski kural): risk = |giriş − (son 8 mumun dibi − 0.25×ATR)|, 1–2.5 ATR arasına sınırlı;
 * hedef = giriş + riskReward × risk. Giriş = sinyal mumunun kapanışı.
 */
export function computePlan(h1: Candle[], side: PositionSide, a: number, p: Pick<ConsensusParams, "riskReward">): SignalPlan {
  const i = h1.length - 1;
  const price = h1[i].close;
  const dir = side === "LONG" ? 1 : -1;
  const window = h1.slice(Math.max(0, i - 7), i + 1);
  const swing = side === "LONG" ? Math.min(...window.map((c) => c.low)) : Math.max(...window.map((c) => c.high));
  let risk = Math.abs(price - (swing - dir * 0.25 * a));
  risk = Math.min(Math.max(risk, a), 2.5 * a);
  return {
    side,
    entry: price,
    stopLoss: price - dir * risk,
    takeProfit: price + dir * risk * p.riskReward,
    riskReward: p.riskReward,
    atr: a,
    stopRule: `Stop = son 8 mum ${side === "LONG" ? "dibi −" : "tepesi +"} 0.25×ATR (1–2.5 ATR arası)`,
    tpAdjusted: false,
    resistance: null,
  };
}

function fmt(n: number): string {
  const d = n >= 1000 ? 2 : n >= 10 ? 3 : n >= 1 ? 4 : 6;
  return n.toLocaleString("tr-TR", { minimumFractionDigits: d, maximumFractionDigits: d });
}
