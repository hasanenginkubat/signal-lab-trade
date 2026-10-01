// ---------- Piyasa verisi ----------

export type Interval = "1m" | "5m" | "15m" | "1h" | "4h" | "1d";

export interface Candle {
  symbol: string;
  interval: string;
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  isClosed: boolean;
}

export interface Ticker {
  symbol: string;
  price: number;
  open: number;
  high: number;
  low: number;
  changePct: number;
  /** 24 saatlik USDT hacmi */
  quoteVolume: number;
  updatedAt: number;
}

export type Trend = "UP" | "DOWN" | "NEUTRAL";

/** Bir sembolün sinyal aralığındaki anlık teknik görünümü (izleme listesi için). */
export interface SymbolBias {
  symbol: string;
  interval: Interval;
  trend: Trend;
  rsi: number | null;
  /** -10 (çok ayı) ile +10 (çok boğa) arası birleşik skor */
  score: number;
  updatedAt: number;
}

export interface SymbolOverview {
  symbol: string;
  ticker: Ticker | null;
  bias: SymbolBias | null;
}

// ---------- Sinyaller ----------

export type PositionSide = "LONG" | "SHORT";

/** MISSED: akıllı giriş emri dolmadan fırsat kaçtı (hedefe gitti ya da süre doldu) */
export type SignalStatus = "OPEN" | "TP_HIT" | "SL_HIT" | "EXPIRED" | "MISSED";

export interface Signal {
  id: string;
  symbol: string;
  interval: Interval;
  side: PositionSide;
  /** Sinyal mumunun kapanış fiyatı */
  price: number;
  /** Sinyal mumunun açılış zamanı (grafikte işaretleme için) */
  candleTime: number;
  createdAt: number;
  /** 0-100 arası güç */
  strength: number;
  score: number;
  reasons: string[];
  stopLoss: number;
  takeProfit: number;
  status: SignalStatus;
  closedAt: number | null;
  closePrice: number | null;
  /** Kaldıraçsız fiyat değişimi yüzdesi (yön dikkate alınarak) */
  resultPct: number | null;
  /** 0-100: skor, trend gücü, üst zaman dilimi uyumu ve geçmiş başarının birleşimi */
  confidence?: number;
  /** Ödül / risk oranı (TP mesafesi / SL mesafesi) */
  riskReward?: number;
  /** Bu coin + aralıkta aynı stratejinin geçmiş (backtest) sonucu */
  history?: TrackRecord | null;
  /** İlk stop seviyesi (stop başa başa taşınırsa `stopLoss` değişir) */
  initialStopLoss?: number;
  /** Fiyat +1R gidince stop başa baş seviyesine taşındı mı */
  stopMoved?: boolean;
  /** Konsensüs sinyali: tüm analizlerin birleşimi */
  kind?: "consensus" | "strategy";
  /** A+ = kırılım veya 2+ strateji + ADX ≥ 25 + BTC düşüşte değil (testte en yüksek isabet) */
  quality?: SignalQuality;
  /** Kalite gerekçeleri (sade dille) */
  qualityNotes?: string[];
  /** Akıllı giriş: sinyal fiyatının biraz altındaki limit seviyesi (geri çekilmede alım) */
  entryLimit?: number;
  /** Akıllı giriş emrinin geçerlilik sonu (ms) */
  entryValidUntil?: number;
  /** Analist notu: kurulum, teyitler, plan, geçersizlik ve risk (düz metin) */
  note?: string;
  /** Akıllı giriş doldu mu: dolum fiyatı ve zamanı (takip bu fiyattan yapılır) */
  fillPrice?: number | null;
  filledAt?: number | null;
  /** "GÜÇLÜ AL" | "AL" */
  label?: string;
  /** −100…+100 */
  consensus?: number;
  checklist?: ChecklistItem[];
}

/** Konsensüsü oluşturan tek bir koşul */
export interface ChecklistItem {
  key: string;
  label: string;
  /** +1 AL, −1 SAT, 0 nötr */
  vote: -1 | 0 | 1;
  weight: number;
  detail: string;
  trigger?: boolean;
  /** Skora katkı (−1…+1) */
  value?: number;
  /** Birleşik bileşenin alt oyları (ör. Haftalık/Günlük/4s/1s) */
  parts?: { label: string; vote: -1 | 0 | 1 }[];
}

/**
 * AL / GÜÇLÜ AL yalnızca sinyal kapısının TÜM kontrolleri geçtiğinde verilir.
 * İZLE: skor yüksek ama kapı geçilmedi ("güçlü görünüm"); UZAK DUR: skor çok düşük ve short kapalı.
 */
export type ConsensusLabel = "GÜÇLÜ AL" | "AL" | "İZLE" | "BEKLE" | "UZAK DUR" | "SAT" | "GÜÇLÜ SAT";

/** Sinyal kapısındaki tek bir kontrol */
export interface GateCheck {
  key: string;
  label: string;
  ok: boolean;
  detail: string;
}

/** Kapıyı geçen sinyalin işlem planı — sinyal mumunun kapanışından hesaplanır, canlı fiyatla değişmez */
export interface SignalPlan {
  side: PositionSide;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  /** Gerçekleşen ödül/risk (direnç nedeniyle TP çekildiyse hedeften düşük olabilir) */
  riskReward: number;
  atr: number;
  /** Stop kuralının sade açıklaması */
  stopRule: string;
  /** Hedef yolundaki güçlü direnç nedeniyle TP aşağı çekildi mi */
  tpAdjusted: boolean;
  resistance: number | null;
}

export type SignalQuality = "A+" | "A";

/** Bir coin için tüm analizlerin birleşik anlık görünümü */
export interface ConsensusView {
  symbol: string;
  /** −100 (her şey SAT) … +100 (her şey AL) */
  score: number;
  label: ConsensusLabel;
  /** Baskın yönü destekleyen koşul sayısı */
  agree: number;
  total: number;
  items: ChecklistItem[];
  levels: { dayOpen: number | null; weekOpen: number | null; vwap: number | null };
  /** Sinyal neden henüz oluşmadı (oluştuysa null) */
  blockedBy: string | null;
  /** Son mumda sinyal koşulları sağlandıysa kalitesi */
  quality: SignalQuality | null;
  /** BTC 4 saatlik trendi (piyasa yönü) */
  btcTrend: Trend | null;
  /** BTC günlük trendi (piyasa rejimi) — A+ için yukarı olmalı */
  btcDailyTrend: Trend | null;
  /** Sinyal kapısı: tüm kontroller geçti mi (AL yalnızca bu durumda) */
  passed: boolean;
  checks: GateCheck[];
  /** Yalnızca kapı geçildiğinde dolu */
  plan: SignalPlan | null;
  /** Baskın yönü destekleyen bileşen oranı (%) — agree / total */
  confidence: number;
  adx: number | null;
  rsi: number | null;
  /** 1s ATR(14) — plan yokken emir panelindeki varsayılan ATR stop için */
  atr: number | null;
  /** Değerlendirilen 1s mumun açılış zamanı */
  candleTime: number | null;
  updatedAt: number;
}

/**
 * Stratejinin geçmiş veride ölçülen performansı. Kazanç YALNIZCA hedefe (TP) ulaşan işlemdir;
 * başa baş (BE) ve kayıp (SL) ayrı sayılır. Ücret + kayma düşülmüştür.
 */
export interface TrackRecord {
  trades: number;
  /** Hedefe ulaşan */
  wins: number;
  /** Stop girişe çekilip orada kapanan (ücret sonrası hafif eksi) */
  breakevens: number;
  /** Stop olan */
  losses: number;
  /** 48 saatte sonuçlanmayan (zaman stopu) */
  expired: number;
  /** wins / trades */
  winRatePct: number;
  breakevenPct: number;
  lossPct: number;
  /** Ücretler düşüldükten sonra işlem başına ortalama net getiri (%) */
  expectancyPct: number;
  profitFactor: number;
  /** n ≥ 30 mu (değilse oranlar gösterilmez) */
  sufficient: boolean;
}

export interface BacktestResult extends TrackRecord {
  symbol: string;
  interval: Interval;
  avgWinPct: number;
  avgLossPct: number;
  /** Test edilen dönemin başlangıç/bitişi */
  from: number;
  to: number;
  updatedAt: number;
}

/** Backtest'in geçmişte ürettiği bir AL sinyali (grafikte göstermek için) */
export interface HistorySignal {
  symbol: string;
  side: PositionSide;
  /** Sinyal mumunun açılış zamanı */
  candleTime: number;
  /** Girişin gerçekleştiği zaman (akıllı girişte dolum mumunun açılışı) */
  entryTime: number;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  quality: SignalQuality;
  /** Kaçırıldı: akıllı giriş emri dolmadı */
  outcome: "TP" | "SL" | "BE" | "EXPIRED" | "MISSED";
  exit: number | null;
  exitTime: number | null;
  /** Ücretler sonrası net (%) */
  netPct: number | null;
}

export interface BacktestBand extends TrackRecord {
  label: string;
  /** Akıllı girişte dolmayan (kaçırılan) emir sayısı */
  missed?: number;
}

/** Bir test döneminin tüm coinler üzerinden özeti */
export interface PeriodReport extends TrackRecord {
  from: number;
  to: number;
  coins: number;
  /** İşlem başına bakiyenin %1'i riske edilerek bileşik equity eğrisinde en büyük düşüş (%) */
  maxDrawdownPct: number;
  /** Aynı equity eğrisinin dönem sonu getirisi (%) */
  equityReturnPct: number;
  /** Aynı dönemde coinleri eşit ağırlıkla alıp tutmanın getirisi (%) */
  buyHoldPct: number;
  btcBuyHoldPct: number | null;
}

export interface BacktestSummary {
  running: boolean;
  updatedAt: number | null;
  /** Strateji parametrelerinin sürümü (değişince sonuçlar yeniden hesaplanır) */
  strategyVersion: string;
  /**
   * Örneklem dışı (walk-forward) dönem: kurallar bu dönemi HİÇ görmeden seçildi.
   * Coin karneleri ve "tahmini başarı" buradan gelir.
   */
  outOfSample: PeriodReport | null;
  /** Son ~60 gün (kuralların seçildiği döneme yakın — iyimser olabilir) */
  inSample: PeriodReport | null;
  /** Örneklem dışı dönemde A+ / A ayrımı */
  bands: BacktestBand[];
  /** Örneklem dışı dönemde coin bazında sonuçlar */
  results: BacktestResult[];
}

// ---------- Teknik analiz ----------

/** AVOID: koşullar aşağı yönlü ve short kapalı → "uzak dur" */
export type Verdict = "STRONG_BUY" | "BUY" | "NEUTRAL" | "AVOID" | "SELL" | "STRONG_SELL";

export type Tone = "bull" | "bear" | "neutral";

export interface AnalysisPoint {
  /** Kısa başlık: "Trend", "Momentum"… */
  title: string;
  tone: Tone;
  /** Grafik bilmeyen birinin anlayacağı açıklama */
  text: string;
}

export interface TimeframeView {
  interval: Interval;
  trend: Trend;
  score: number;
  rsi: number | null;
}

export interface PriceLevel {
  price: number;
  kind: "support" | "resistance";
  /** Kaç kez test edildiği (güç) */
  touches: number;
  distancePct: number;
}

export interface TradePlan {
  side: PositionSide;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  riskReward: number;
  /** Planın sade dille özeti */
  note: string;
}

export interface TechnicalAnalysis {
  symbol: string;
  interval: Interval;
  price: number;
  updatedAt: number;
  verdict: Verdict;
  /** -10..+10 */
  score: number;
  /** 0-100: göstergelerin ne kadar aynı yönü gösterdiği */
  confidence: number;
  headline: string;
  summary: string;
  points: AnalysisPoint[];
  timeframes: TimeframeView[];
  levels: PriceLevel[];
  plan: TradePlan | null;
  volatility: { atrPct: number; level: "low" | "normal" | "high"; text: string };
  indicators: {
    rsi: number | null;
    adx: number | null;
    macdHistogram: number | null;
    ema21: number | null;
    ema50: number | null;
    ema200: number | null;
  };
  track: TrackRecord | null;
  consensus?: ConsensusView | null;
}

// ---------- Risk kalkanı ----------

export interface GuardStatus {
  enabled: boolean;
  /** Tüm kurallar uygun mu (tek tık bu durumda çalışır) */
  canTrade: boolean;
  /** Engelleyen kurallar (sade dille) */
  reasons: string[];
  openPositions: number;
  maxOpen: number;
  lossesToday: number;
  dayStopLosses: number;
  consecutiveLosses: number;
  breakerLosses: number;
  /** Üst üste kayıp molası bitişi (ms) */
  pausedUntil: number | null;
  btcDailyTrend: Trend | null;
  regimeOk: boolean;
}

// ---------- Günlük rapor ----------

export interface MarketReport {
  generatedAt: number;
  regime: { label: "UYGUN" | "TEMKİNLİ" | "UYGUN DEĞİL"; tone: Tone; text: string };
  headline: string;
  /** Rapor paragrafları (sade dille) */
  paragraphs: string[];
  top: ConsensusView[];
  avoid: ConsensusView[];
  activeSignals: Signal[];
  guard: GuardStatus;
  /** Panoya kopyalanabilir düz metin rapor */
  text: string;
}

// ---------- Gün içi fırsat taraması ----------

export interface Opportunity {
  symbol: string;
  price: number;
  changePct: number;
  quoteVolume: number;
  /** 24 saatlik en yüksek-en düşük aralığı (%) */
  rangePct: number;
  /** 15dk ATR / fiyat (%) — bir mumda ortalama hareket */
  atrPct: number;
  /** 1s ADX — trendin gücü */
  adx: number | null;
  trend: Trend;
  /** 0-100 gün içi işlem uygunluğu */
  score: number;
  label: "Çok uygun" | "Uygun" | "Orta" | "Zayıf";
  reason: string;
}

export interface ScorecardRow {
  key: string;
  total: number;
  open: number;
  /** Hedefe ulaşan */
  wins: number;
  /** Stop girişe çekilip orada kapanan */
  breakevens: number;
  /** Stop olan */
  losses: number;
  expired: number;
  /** Akıllı giriş dolmadı */
  missed: number;
  /** wins / (kapanan işlem) — kaçırılanlar hariç */
  winRatePct: number;
  /** Kapanan işlemlerin ücret+kayma sonrası ortalama sonucu (%) */
  avgResultPct: number;
  totalResultPct: number;
}

export interface Scorecard {
  overall: ScorecardRow;
  bySymbol: ScorecardRow[];
  byInterval: ScorecardRow[];
  bySide: ScorecardRow[];
}

// ---------- İşlem / hesap ----------

export type AccountMode = "paper" | "binance";

export type OrderType = "MARKET" | "LIMIT";

export interface OpenPositionRequest {
  symbol: string;
  side: PositionSide;
  type: OrderType;
  /** Pozisyona ayrılacak teminat (USDT) */
  margin: number;
  leverage: number;
  limitPrice?: number;
  stopLoss?: number | null;
  takeProfit?: number | null;
  signalId?: string | null;
  /** Fiyat bu kadar R kâra geçince SL otomatik başa başa taşınır (null = kapalı) */
  breakevenAtR?: number | null;
  /** Limit emir bu zamana kadar dolmazsa iptal edilir (ms) */
  expiresAt?: number | null;
  /** Limit emir dolmadan fiyat bu seviyeye ulaşırsa (hedefe kaçtı) iptal edilir */
  cancelIfPriceReaches?: number | null;
  /** Zaman stopu: pozisyon açıldıktan bu kadar ms sonra hâlâ açıksa piyasa fiyatından kapatılır */
  maxHoldMs?: number | null;
}

export interface UpdateProtectionRequest {
  stopLoss: number | null;
  takeProfit: number | null;
}

export interface Position {
  id: string;
  symbol: string;
  side: PositionSide;
  entryPrice: number;
  markPrice: number;
  quantity: number;
  leverage: number;
  /** Pozisyona kilitli teminat (isolated) */
  margin: number;
  notional: number;
  unrealizedPnl: number;
  /** Teminata göre getiri yüzdesi */
  roePct: number;
  liquidationPrice: number;
  stopLoss: number | null;
  takeProfit: number | null;
  openedAt: number;
  signalId: string | null;
  /** Otomatik başa baş ayarı (R cinsinden), yoksa null */
  breakevenAtR?: number | null;
  /** Zaman stopu: bu andan sonra hâlâ açıksa kapatılır (ms) */
  closeAt?: number | null;
}

export interface PendingOrder {
  id: string;
  symbol: string;
  side: PositionSide;
  type: "LIMIT";
  price: number;
  margin: number;
  leverage: number;
  stopLoss: number | null;
  takeProfit: number | null;
  createdAt: number;
  signalId: string | null;
  breakevenAtR?: number | null;
  expiresAt?: number | null;
  cancelIfPriceReaches?: number | null;
  maxHoldMs?: number | null;
}

export type CloseReason = "MANUAL" | "STOP_LOSS" | "TAKE_PROFIT" | "LIQUIDATION" | "TIME_STOP";

export interface Trade {
  id: string;
  positionId: string;
  symbol: string;
  side: PositionSide;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  leverage: number;
  margin: number;
  /** Ücretler düşülmüş net kâr/zarar */
  realizedPnl: number;
  fees: number;
  roePct: number;
  openedAt: number;
  closedAt: number;
  reason: CloseReason;
  signalId: string | null;
}

export interface AccountSummary {
  mode: AccountMode;
  currency: "USDT";
  /** Gerçekleşmiş kâr/zararlar dahil cüzdan bakiyesi */
  walletBalance: number;
  unrealizedPnl: number;
  /** Cüzdan + gerçekleşmemiş K/Z (marjin bakiyesi) */
  equity: number;
  /** Açık pozisyonlara kilitli teminat */
  usedMargin: number;
  /** Bekleyen emirler için ayrılan teminat */
  orderMargin: number;
  availableBalance: number;
  maintenanceMargin: number;
  /** Bakım marjı / marjin bakiyesi. %100 olunca likidasyon. */
  marginRatioPct: number;
  initialBalance: number;
  realizedPnlTotal: number;
  realizedPnlToday: number;
  feesTotal: number;
  tradeCount: number;
  winRatePct: number;
  returnPct: number;
  updatedAt: number;
}

export interface AccountState {
  summary: AccountSummary;
  positions: Position[];
  orders: PendingOrder[];
}

export interface EquityPoint {
  time: number;
  equity: number;
  walletBalance: number;
}

// ---------- WebSocket mesajları ----------

export type ServerMessage =
  | { type: "hello"; data: { mode: AccountMode; symbols: string[]; signalIntervals: Interval[]; aPlusOnly?: boolean } }
  | { type: "candle"; data: Candle }
  | { type: "tickers"; data: Ticker[] }
  | { type: "bias"; data: SymbolBias }
  | { type: "signal"; data: Signal }
  | { type: "signalUpdate"; data: Signal }
  | { type: "account"; data: AccountState }
  | { type: "trade"; data: Trade }
  | { type: "notice"; data: { level: "info" | "warn" | "error"; message: string } }
  | { type: "status"; data: { binance: "connected" | "connecting" | "disconnected" } }
  | { type: "opportunities"; data: Opportunity[] }
  | { type: "consensus"; data: ConsensusView }
  | { type: "exitAlert"; data: { symbol: string; score: number; message: string } };

export type ClientMessage =
  | { type: "subscribe"; symbol: string; interval: Interval }
  | { type: "unsubscribe" }
  | { type: "ping" };

// ---------- Canlı karne (kâğıt hesap vs al-tut) ----------

export type LiveOutcome = "TP" | "BE" | "SL" | "EXPIRED";

/** Canlı izleme döneminde kapanmış bir kâğıt işlem (sinyal takipçisinin sonucu) */
export interface LiveTrade {
  /** Sinyal kimliği */
  id: string;
  symbol: string;
  quality: SignalQuality | null;
  side: PositionSide;
  entryTime: number;
  entryPrice: number;
  exitTime: number;
  exitPrice: number;
  /** İlk stop (başa başa taşınmadan önceki) */
  stopLoss: number;
  takeProfit: number;
  outcome: LiveOutcome;
  /** Fiyat sonucu, %0.14 maliyet düşülmüş (kaldıraçsız) */
  netPct: number;
  /** Bakiyeye etkisi (%): işlem başına bakiyenin riskPct'i riske edilir */
  balanceEffectPct: number;
  /** İşlem sonrası bot bakiyesi (başlangıç = 100) */
  balanceAfter: number;
}

/** Bakiye eğrisi noktası; üçü de başlangıçta 100 */
export interface LivePoint {
  time: number;
  bot: number;
  btc: number;
  basket: number;
}

export interface LiveWeek {
  /** Binance haftası başlangıcı (Pazartesi 00:00 UTC = TR 03:00) */
  weekStart: number;
  trades: number;
  wins: number;
  breakevens: number;
  losses: number;
  expired: number;
  botPct: number;
  btcPct: number;
  basketPct: number;
  /** bot − BTC (yüzde puan) */
  diffPct: number;
}

export interface LiveSummary {
  trades: number;
  days: number;
  perDay: number;
  wins: number;
  breakevens: number;
  losses: number;
  expired: number;
  winRatePct: number;
  profitFactor: number;
  botReturnPct: number;
  btcReturnPct: number;
  basketReturnPct: number;
  botMaxDdPct: number;
  btcMaxDdPct: number;
  basketMaxDdPct: number;
  /** n ≥ 30 mu (değilse sonuç yorumlanamaz) */
  sufficient: boolean;
}

export interface LiveReport {
  trackingStart: number;
  /** Başlangıçta sabitlenen sepet (eşit ağırlık) */
  basket: string[];
  /** Sayılan sinyal kalitesi */
  quality: SignalQuality;
  riskPct: number;
  updatedAt: number | null;
  /** Şu an açık (henüz sonuçlanmamış) sayılan işlem sayısı */
  open: number;
  /** Akıllı giriş dolmadığı için açılmayan sinyaller */
  missed: number;
  points: LivePoint[];
  weeks: LiveWeek[];
  summary: LiveSummary;
  trades: LiveTrade[];
}
