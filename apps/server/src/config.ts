import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  DEFAULT_SYMBOLS,
  isInterval,
  type AccountMode,
  type Interval,
} from "@signal-lab/shared";

// .env dosyası varsa yükle (önce apps/server/.env, sonra kök dizin)
for (const candidate of [resolve(process.cwd(), ".env"), resolve(process.cwd(), "../../.env")]) {
  if (existsSync(candidate)) {
    process.loadEnvFile(candidate);
    break;
  }
}

function list(name: string, fallback: readonly string[]): string[] {
  const raw = process.env[name];
  if (!raw) return [...fallback];
  return raw
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} sayı olmalı, gelen: ${raw}`);
  return value;
}

const signalIntervals = list("SIGNAL_INTERVALS", ["1h"]).map((s) => s.toLowerCase());
for (const iv of signalIntervals) {
  if (!isInterval(iv)) throw new Error(`Geçersiz SIGNAL_INTERVALS değeri: ${iv}`);
}

const mode = (process.env.TRADING_MODE ?? "paper").toLowerCase() as AccountMode;
if (mode !== "paper" && mode !== "binance") {
  throw new Error(`TRADING_MODE "paper" ya da "binance" olmalı, gelen: ${mode}`);
}

export const config = {
  port: num("PORT", 4000),
  corsOrigin: process.env.CORS_ORIGIN ?? "*",
  dataDir: resolve(process.env.DATA_DIR ?? resolve(process.cwd(), "data")),

  /** "auto" (varsayılan): hacim + günlük harekete göre otomatik seçim; ya da virgüllü liste */
  symbols: (process.env.SYMBOLS ?? "auto").trim().toLowerCase() === "auto" ? null : list("SYMBOLS", DEFAULT_SYMBOLS),
  fallbackSymbols: [...DEFAULT_SYMBOLS] as string[],
  universe: {
    size: num("UNIVERSE_SIZE", 50),
    minQuoteVolume: num("UNIVERSE_MIN_VOLUME", 50_000_000),
    minAgeDays: num("UNIVERSE_MIN_AGE_DAYS", 60),
  },
  signalIntervals: signalIntervals as Interval[],
  /** Sinyal motorunun hafızada tuttuğu mum sayısı */
  historyLimit: num("HISTORY_LIMIT", 500),

  /** Piyasa verisi her zaman Binance USDⓈ-M Futures'tan gelir (herkese açık uç noktalar). */
  marketRestBase: process.env.BINANCE_MARKET_REST ?? "https://fapi.binance.com",
  marketWsBase: process.env.BINANCE_MARKET_WS ?? "wss://fstream.binance.com/market",

  trading: {
    mode,
    /** Hem kâğıt hem gerçek hesapta izin verilen en yüksek kaldıraç (arayüz varsayılanı 1x) */
    maxLeverage: num("MAX_LEVERAGE", 5),
    paper: {
      initialBalance: num("PAPER_INITIAL_BALANCE", 100),
      takerFeeRate: num("PAPER_TAKER_FEE", 0.0005),
      makerFeeRate: num("PAPER_MAKER_FEE", 0.0002),
      maintenanceMarginRate: num("PAPER_MAINT_MARGIN_RATE", 0.005),
    },
    binance: {
      apiKey: process.env.BINANCE_API_KEY ?? "",
      apiSecret: process.env.BINANCE_API_SECRET ?? "",
      /** Testnet için: https://demo-fapi.binance.com */
      restBase: process.env.BINANCE_TRADE_REST ?? "https://fapi.binance.com",
      recvWindow: num("BINANCE_RECV_WINDOW", 5000),
    },
  },

  /**
   * Risk kalkanı — 8 aylık testte en büyük düşüşü %25'ten %8.4'e indiren kurallar.
   * Tek tıkla işlem bu kurallar ihlal edildiğinde engellenir (manuel emir paneli serbesttir).
   */
  guard: {
    enabled: (process.env.GUARD_ENABLED ?? "true") !== "false",
    maxOpen: num("GUARD_MAX_OPEN", 5),
    dayStopLosses: num("GUARD_DAY_STOP_LOSSES", 2),
    breakerLosses: num("GUARD_BREAKER_LOSSES", 4),
    pauseDays: num("GUARD_PAUSE_DAYS", 3),
    requireBtcUp: (process.env.GUARD_REQUIRE_BTC_UP ?? "true") !== "false",
  },
  /** Konsensüs (tüm analizlerin birleşimi) — sinyaller 1s mum kapanışlarında üretilir */
  consensus: {
    /** Sinyal için gereken en düşük konsensüs (%) */
    threshold: num("CONSENSUS_THRESHOLD", 70),
    /** Sinyal kapısı: ADX bunun altındaysa AL yok, plan yok (analiz paneli de BEKLE der) */
    minAdx: num("CONSENSUS_MIN_ADX", 18),
    /** A+ (GÜÇLÜ AL) için gereken ADX */
    aPlusMinAdx: num("CONSENSUS_APLUS_MIN_ADX", 25),
    /** Konsensüs bu değerin altına inince UZAK DUR uyarısı (negatif) */
    exitAlert: num("CONSENSUS_EXIT_ALERT", -70),
  },
  strategy: {
    minScore: num("SIGNAL_MIN_SCORE", 4),
    /** Trend devamı stratejisinin kendi stop sınırı için ATR çarpanı */
    atrStopMultiplier: num("SIGNAL_ATR_SL", 1.5),
    /** Trend devamı stratejisinin kendi ADX filtresi; 0 = kapalı */
    minAdx: num("SIGNAL_MIN_ADX", 20),
    /** Üst zaman diliminin trendi sinyalle aynı yönde olmalı mı */
    requireHigherTimeframe: (process.env.SIGNAL_REQUIRE_HTF ?? "true") !== "false",
    /**
     * Plan: stop = son 8 mumun dibi − 0.25×ATR, 1–2.5 ATR arasına sınırlı; hedef = giriş + riskReward × risk.
     */
    riskReward: num("SIGNAL_RR", 1.5),
    allowShort: (process.env.SIGNAL_ALLOW_SHORT ?? "false") === "true",
    /** Fiyat bu kadar R ilerleyince stop GİRİŞ fiyatına çekilir (ücret sonrası hafif eksi); 0 = kapalı */
    breakevenAtR: num("SIGNAL_BREAKEVEN_R", 1),
    /** Pozisyon KAPANDIKTAN sonra aynı coinde yeni sinyal için beklenecek mum sayısı */
    cooldownCandles: num("SIGNAL_COOLDOWN", 6),
    /** Sinyalin TP/SL görmeden kapanacağı mum sayısı */
    expiryCandles: num("SIGNAL_EXPIRY", 48),
  },
  /** Seçici mod: sadece A+ sinyallere bildirim ve işlem butonu. Arayüz her açılışta bu değere döner. */
  selective: {
    aPlusOnly: (process.env.SELECTIVE_APLUS_ONLY ?? "true") !== "false",
  },
  /**
   * Canlı karne (kâğıt hesap vs al-tut). Bu andan önce açılan hiçbir sinyal sayılmaz; değiştirilirse
   * karne sıfırdan başlar (eski kayıt live-scorecard.json içinde ezilir).
   */
  live: {
    trackingStart: Date.parse(process.env.TRACKING_START ?? "2026-10-01T13:54:00Z"),
    /** Bot bakiyesi: her işlemde bakiyenin bu yüzdesi riske edilir (backtest ile aynı) */
    riskPct: num("LIVE_RISK_PCT", 1),
  },
  /** Backtest ve karne maliyet modeli: her işlemde giriş + çıkış taker ücreti ve kayma */
  costs: {
    takerFeePct: num("COST_TAKER_FEE_PCT", 0.05),
    slippagePct: num("COST_SLIPPAGE_PCT", 0.02),
  },
  /**
   * Walk-forward: kurallar 2026-02 sonrası veriye bakılarak seçildi. Karne ve "tahmini başarı"
   * bu tarihten ÖNCEKİ, hiç kullanılmamış dönemden hesaplanır.
   */
  outOfSample: {
    from: Date.parse(process.env.OOS_FROM ?? "2025-07-01T00:00:00Z"),
    to: Date.parse(process.env.OOS_TO ?? "2026-02-01T00:00:00Z"),
  },
} as const;

export type Config = typeof config;
