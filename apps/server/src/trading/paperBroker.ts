import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  MAX_LEVERAGE,
  type AccountState,
  type AccountSummary,
  type CloseReason,
  type EquityPoint,
  type OpenPositionRequest,
  type PendingOrder,
  type Position,
  type PositionSide,
  type Trade,
  type UpdateProtectionRequest,
} from "@signal-lab/shared";
import { minOrderUsd, type SymbolFilters } from "../binance/rest";
import { JsonStore } from "../db/jsonStore";
import { liquidationPrice, pnl, startOfDay, validateOpenRequest, validateProtection } from "./math";
import { TradingError, type Broker, type BrokerEvents } from "./types";

export interface PaperSettings {
  initialBalance: number;
  takerFeeRate: number;
  makerFeeRate: number;
  maintenanceMarginRate: number;
  /** İzin verilen en yüksek kaldıraç */
  maxLeverage?: number;
}

/** Fiyat kaynağı (MarketData bu arayüzü sağlar). */
export interface PriceFeed {
  getPrice(symbol: string): number | null;
  hasSymbol(symbol: string): boolean;
  on(event: "price", listener: (symbol: string, price: number) => void): unknown;
}

interface PaperPosition {
  id: string;
  symbol: string;
  side: PositionSide;
  entryPrice: number;
  quantity: number;
  leverage: number;
  margin: number;
  /** Henüz kapanmamış kısmın açılış ücreti (gerçekleşen K/Z'ye oransal yansıtılır) */
  openFee: number;
  stopLoss: number | null;
  takeProfit: number | null;
  openedAt: number;
  signalId: string | null;
  /** Otomatik başa baş: fiyat bu kadar R kâra geçince SL girişe çekilir */
  breakevenAtR?: number | null;
  /** Başa baş hesabı için ilk risk mesafesi (giriş − ilk SL) */
  initialRisk?: number | null;
  breakevenDone?: boolean;
  /** Zaman stopu (ms) */
  closeAt?: number | null;
}

interface PaperState {
  initialBalance: number;
  walletBalance: number;
  feesTotal: number;
  positions: PaperPosition[];
  orders: PendingOrder[];
  trades: Trade[];
  equity: EquityPoint[];
}

const MAX_TRADES = 5000;
const MAX_EQUITY_POINTS = 5000;
const EQUITY_SNAPSHOT_MS = 5 * 60_000;

/**
 * Binance USDⓈ-M Futures kurallarına yakın çalışan simülasyon hesabı:
 * isolated marjin, kaldıraç, taker/maker ücretleri, likidasyon, SL/TP, limit emirler,
 * kısmi kapatma ve sermaye (equity) eğrisi. Durum diskte saklanır.
 */
export class PaperBroker extends EventEmitter<BrokerEvents> implements Broker {
  readonly mode = "paper" as const;
  private state: PaperState;
  private readonly store: JsonStore<PaperState>;
  private snapshotTimer: NodeJS.Timeout | null = null;
  private expiryTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly feed: PriceFeed,
    private readonly settings: PaperSettings,
    dataDir: string,
  ) {
    super();
    this.store = new JsonStore<PaperState>(dataDir, "paper-account.json");
    this.state = this.store.load(this.freshState(settings.initialBalance));
  }

  /** Binance'in coin bazlı emir kuralları (min. miktar / min. büyüklük) — gerçek hesapla aynı davranmak için */
  private filters = new Map<string, SymbolFilters>();

  setFilters(filters: Map<string, SymbolFilters>): void {
    this.filters = filters;
  }

  async start(): Promise<void> {
    this.feed.on("price", (symbol, price) => this.onPrice(symbol, price));
    // Fiyat akışı olmasa da süresi dolan emirleri temizle
    this.expiryTimer = setInterval(() => this.sweepOrders(), 30_000);
    if (this.state.equity.length === 0) this.snapshot();
    this.snapshotTimer = setInterval(() => this.snapshot(), EQUITY_SNAPSHOT_MS);
  }

  stop(): void {
    if (this.snapshotTimer) clearInterval(this.snapshotTimer);
    if (this.expiryTimer) clearInterval(this.expiryTimer);
    this.store.flush(() => this.state);
  }

  async getState(): Promise<AccountState> {
    return this.buildState();
  }

  async openPosition(req: OpenPositionRequest): Promise<Position | PendingOrder> {
    const symbol = req.symbol?.toUpperCase();
    if (!symbol || !this.feed.hasSymbol(symbol)) throw new TradingError(`Bilinmeyen sembol: ${req.symbol}`);
    const market = this.feed.getPrice(symbol);
    if (!market) throw new TradingError("Bu sembol için henüz fiyat yok, birkaç saniye sonra tekrar deneyin");

    const entry = req.type === "LIMIT" ? Number(req.limitPrice) : market;
    validateOpenRequest({ ...req, symbol }, entry, this.settings.maxLeverage ?? MAX_LEVERAGE);
    const f = this.filters.get(symbol);
    if (f) {
      const notional = req.margin * req.leverage;
      const need = minOrderUsd(f, entry);
      if (notional + 1e-9 < need) {
        throw new TradingError(
          `${symbol} için Binance'in minimum emir büyüklüğü ${need.toFixed(2)} USDT (en az ${f.minQty} adet); bu emir ${notional.toFixed(2)} USDT. ` +
            "Gerçek hesapta da reddedilir — bu coini atlayın ya da pozisyonu büyütün.",
        );
      }
    }

    const feeRate = req.type === "LIMIT" ? this.settings.makerFeeRate : this.settings.takerFeeRate;
    const estFee = req.margin * req.leverage * feeRate;
    const available = this.computeSummary().availableBalance;
    if (req.margin + estFee > available + 1e-9) {
      throw new TradingError(
        `Yetersiz bakiye. Gerekli: ${(req.margin + estFee).toFixed(2)} USDT, kullanılabilir: ${available.toFixed(2)} USDT`,
      );
    }

    if (req.type === "LIMIT") {
      // Limit fiyatı piyasadan iyi değilse anında dolar (Binance'teki gibi taker olarak)
      const marketable = req.side === "LONG" ? entry >= market : entry <= market;
      if (!marketable) {
        const order: PendingOrder = {
          id: randomUUID(),
          symbol,
          side: req.side,
          type: "LIMIT",
          price: entry,
          margin: req.margin,
          leverage: req.leverage,
          stopLoss: req.stopLoss ?? null,
          takeProfit: req.takeProfit ?? null,
          createdAt: Date.now(),
          signalId: req.signalId ?? null,
          breakevenAtR: req.breakevenAtR ?? null,
          expiresAt: req.expiresAt ?? null,
          cancelIfPriceReaches: req.cancelIfPriceReaches ?? null,
          maxHoldMs: req.maxHoldMs ?? null,
        };
        this.state.orders.push(order);
        this.persist();
        this.notice(
          "info",
          `${symbol} ${sideTr(req.side)} limit emri ${px(entry)} fiyatından verildi` +
            (order.expiresAt ? ` (${Math.round((order.expiresAt - Date.now()) / 3_600_000)} saat geçerli)` : ""),
        );
        return order;
      }
    }

    // Piyasa emri ya da piyasadan iyi limit fiyatı: güncel fiyattan taker olarak dolar
    const position = this.fill({
      symbol,
      side: req.side,
      price: market,
      margin: req.margin,
      leverage: req.leverage,
      feeRate: this.settings.takerFeeRate,
      stopLoss: req.stopLoss ?? null,
      takeProfit: req.takeProfit ?? null,
      signalId: req.signalId ?? null,
      breakevenAtR: req.breakevenAtR ?? null,
      maxHoldMs: req.maxHoldMs ?? null,
    });
    return this.toPosition(position, market);
  }

  async closePosition(id: string, percent = 100): Promise<Trade | null> {
    const pos = this.state.positions.find((p) => p.id === id);
    if (!pos) throw new TradingError("Pozisyon bulunamadı", 404);
    if (!(percent > 0 && percent <= 100)) throw new TradingError("Kapatma oranı 1-100 arasında olmalı");
    const price = this.feed.getPrice(pos.symbol);
    if (!price) throw new TradingError("Güncel fiyat alınamadı");
    return this.close(pos, price, "MANUAL", percent / 100);
  }

  async updateProtection(id: string, req: UpdateProtectionRequest): Promise<Position> {
    const pos = this.state.positions.find((p) => p.id === id);
    if (!pos) throw new TradingError("Pozisyon bulunamadı", 404);
    const price = this.feed.getPrice(pos.symbol) ?? pos.entryPrice;
    const sl = req.stopLoss ?? null;
    const tp = req.takeProfit ?? null;
    // SL/TP güncel fiyata göre doğrulanır (kâra geçmiş pozisyonda başabaş SL'ye izin verir)
    validateProtection(pos.side, price, sl, tp);
    pos.stopLoss = sl;
    pos.takeProfit = tp;
    if (!pos.breakevenDone) pos.initialRisk = sl != null ? Math.abs(pos.entryPrice - sl) : null;
    this.persist();
    return this.toPosition(pos, price);
  }

  async cancelOrder(id: string): Promise<void> {
    const idx = this.state.orders.findIndex((o) => o.id === id);
    if (idx < 0) throw new TradingError("Emir bulunamadı", 404);
    const [order] = this.state.orders.splice(idx, 1);
    this.persist();
    this.notice("info", `${order.symbol} limit emri iptal edildi`);
  }

  async getTrades(limit = 200): Promise<Trade[]> {
    return this.state.trades.slice(-limit).reverse();
  }

  async getEquityHistory(): Promise<EquityPoint[]> {
    const live = this.computeSummary();
    return [...this.state.equity, { time: Date.now(), equity: live.equity, walletBalance: live.walletBalance }];
  }

  async reset(initialBalance = this.settings.initialBalance): Promise<void> {
    if (!(initialBalance > 0)) throw new TradingError("Başlangıç bakiyesi sıfırdan büyük olmalı");
    this.state = this.freshState(initialBalance);
    this.snapshot();
    this.persist();
    this.notice("info", `Kâğıt hesap ${initialBalance.toFixed(2)} USDT ile sıfırlandı`);
  }

  // ---------- iç işleyiş ----------

  /** Süresi dolan emirleri iptal eder; değişiklik olduysa true. */
  private sweepOrders(symbol?: string, price?: number): boolean {
    const now = Date.now();
    let changed = false;
    // Zaman stopu: test edilen kuralla aynı (48 saatte sonuçlanmayan işlem kapatılır)
    for (const pos of [...this.state.positions]) {
      if (symbol && pos.symbol !== symbol) continue;
      if (!pos.closeAt || now < pos.closeAt) continue;
      const px = (pos.symbol === symbol ? price : undefined) ?? this.feed.getPrice(pos.symbol);
      if (!px) continue;
      this.close(pos, px, "TIME_STOP", 1);
      changed = true;
    }
    for (const order of [...this.state.orders]) {
      if (symbol && order.symbol !== symbol) continue;
      let reason: string | null = null;
      if (order.expiresAt && now >= order.expiresAt) reason = "süresi doldu, fiyat geri çekilmedi";
      else if (price !== undefined && order.cancelIfPriceReaches != null) {
        const ran = order.side === "LONG" ? price >= order.cancelIfPriceReaches : price <= order.cancelIfPriceReaches;
        if (ran) reason = "fiyat dolmadan hedefe kaçtı";
      }
      if (!reason) continue;
      this.state.orders = this.state.orders.filter((o) => o.id !== order.id);
      this.notice("info", `${order.symbol} limit emri iptal edildi: ${reason}`);
      changed = true;
    }
    if (changed) {
      this.persist();
      this.emit("changed");
    }
    return changed;
  }

  private onPrice(symbol: string, price: number): void {
    let touched = this.sweepOrders(symbol, price);

    for (const order of [...this.state.orders]) {
      if (order.symbol !== symbol) continue;
      const hit = order.side === "LONG" ? price <= order.price : price >= order.price;
      if (!hit) continue;
      this.state.orders = this.state.orders.filter((o) => o.id !== order.id);
      this.fill({
        symbol,
        side: order.side,
        price: order.price,
        margin: order.margin,
        leverage: order.leverage,
        feeRate: this.settings.makerFeeRate,
        stopLoss: order.stopLoss,
        takeProfit: order.takeProfit,
        signalId: order.signalId,
        breakevenAtR: order.breakevenAtR ?? null,
        maxHoldMs: order.maxHoldMs ?? null,
      });
      touched = true;
    }

    for (const pos of [...this.state.positions]) {
      if (pos.symbol !== symbol) continue;
      touched = true;
      const long = pos.side === "LONG";
      const liq = liquidationPrice(pos.side, pos.entryPrice, pos.leverage, this.settings.maintenanceMarginRate);
      if (long ? price <= liq : price >= liq) {
        this.close(pos, liq, "LIQUIDATION", 1);
      } else if (pos.stopLoss != null && (long ? price <= pos.stopLoss : price >= pos.stopLoss)) {
        this.close(pos, price, "STOP_LOSS", 1);
      } else if (pos.takeProfit != null && (long ? price >= pos.takeProfit : price <= pos.takeProfit)) {
        this.close(pos, price, "TAKE_PROFIT", 1);
      } else if (pos.breakevenAtR && pos.initialRisk && !pos.breakevenDone) {
        const trigger = pos.entryPrice + (long ? 1 : -1) * pos.breakevenAtR * pos.initialRisk;
        if (long ? price >= trigger : price <= trigger) {
          // Backtest ile aynı: stop tam girişe (ücret nedeniyle başa baş çıkış hafif eksidir)
          pos.stopLoss = pos.entryPrice;
          pos.breakevenDone = true;
          this.persist();
          this.notice("info", `${pos.symbol} ${pos.breakevenAtR}R kâra geçti — stop girişe taşındı; en kötü ihtimalle ücret kadar eksiyle kapanır`);
        }
      }
    }

    if (touched) this.emit("changed");
  }

  private fill(p: {
    symbol: string;
    side: PositionSide;
    price: number;
    margin: number;
    leverage: number;
    feeRate: number;
    stopLoss: number | null;
    takeProfit: number | null;
    signalId: string | null;
    breakevenAtR?: number | null;
    maxHoldMs?: number | null;
  }): PaperPosition {
    const notional = p.margin * p.leverage;
    const fee = notional * p.feeRate;
    const position: PaperPosition = {
      id: randomUUID(),
      symbol: p.symbol,
      side: p.side,
      entryPrice: p.price,
      quantity: notional / p.price,
      leverage: p.leverage,
      margin: p.margin,
      openFee: fee,
      stopLoss: p.stopLoss,
      takeProfit: p.takeProfit,
      openedAt: Date.now(),
      signalId: p.signalId,
      breakevenAtR: p.breakevenAtR && p.stopLoss != null ? p.breakevenAtR : null,
      closeAt: p.maxHoldMs ? Date.now() + p.maxHoldMs : null,
      initialRisk: p.stopLoss != null ? Math.abs(p.price - p.stopLoss) : null,
      breakevenDone: false,
    };
    this.state.walletBalance -= fee;
    this.state.feesTotal += fee;
    this.state.positions.push(position);
    this.persist();
    this.notice(
      "info",
      `${p.symbol} ${sideTr(p.side)} ${p.leverage}x pozisyon açıldı @ ${px(p.price)} (teminat ${p.margin.toFixed(2)} USDT)`,
    );
    this.emit("changed");
    return position;
  }

  private close(pos: PaperPosition, price: number, reason: CloseReason, fraction: number): Trade {
    const full = fraction >= 0.9999;
    const qty = full ? pos.quantity : pos.quantity * fraction;
    const margin = full ? pos.margin : pos.margin * fraction;
    const openFee = full ? pos.openFee : pos.openFee * fraction;

    let gross = pnl(pos.side, pos.entryPrice, price, qty);
    let closeFee = qty * price * this.settings.takerFeeRate;
    if (reason === "LIQUIDATION") {
      // Isolated marjinde kayıp, pozisyon teminatıyla sınırlıdır
      gross = -margin;
      closeFee = 0;
    }

    this.state.walletBalance += gross - closeFee;
    this.state.feesTotal += closeFee;

    if (full) {
      this.state.positions = this.state.positions.filter((p) => p.id !== pos.id);
    } else {
      pos.quantity -= qty;
      pos.margin -= margin;
      pos.openFee -= openFee;
    }

    const realized = gross - closeFee - openFee;
    const trade: Trade = {
      id: randomUUID(),
      positionId: pos.id,
      symbol: pos.symbol,
      side: pos.side,
      entryPrice: pos.entryPrice,
      exitPrice: price,
      quantity: qty,
      leverage: pos.leverage,
      margin,
      realizedPnl: realized,
      fees: openFee + closeFee,
      roePct: margin > 0 ? (realized / margin) * 100 : 0,
      openedAt: pos.openedAt,
      closedAt: Date.now(),
      reason,
      signalId: pos.signalId,
    };
    this.state.trades.push(trade);
    if (this.state.trades.length > MAX_TRADES) this.state.trades.splice(0, this.state.trades.length - MAX_TRADES);
    this.snapshot();
    this.persist();

    const label: Record<CloseReason, string> = {
      MANUAL: full ? "kapatıldı" : `%${Math.round(fraction * 100)} kısmen kapatıldı`,
      STOP_LOSS: "stop loss ile kapandı",
      TAKE_PROFIT: "take profit ile kapandı",
      LIQUIDATION: "LİKİDE OLDU",
      TIME_STOP: "süre doldu (48 saat), piyasa fiyatından kapatıldı",
    };
    this.notice(
      reason === "LIQUIDATION" ? "error" : reason === "STOP_LOSS" ? "warn" : "info",
      `${pos.symbol} ${sideTr(pos.side)} ${label[reason]}: ${realized >= 0 ? "+" : ""}${realized.toFixed(2)} USDT`,
    );
    this.emit("trade", trade);
    this.emit("changed");
    return trade;
  }

  private toPosition(p: PaperPosition, markPrice: number): Position {
    const unrealized = pnl(p.side, p.entryPrice, markPrice, p.quantity);
    return {
      id: p.id,
      symbol: p.symbol,
      side: p.side,
      entryPrice: p.entryPrice,
      markPrice,
      quantity: p.quantity,
      leverage: p.leverage,
      margin: p.margin,
      notional: p.quantity * markPrice,
      unrealizedPnl: unrealized,
      roePct: p.margin > 0 ? (unrealized / p.margin) * 100 : 0,
      liquidationPrice: liquidationPrice(p.side, p.entryPrice, p.leverage, this.settings.maintenanceMarginRate),
      stopLoss: p.stopLoss,
      takeProfit: p.takeProfit,
      openedAt: p.openedAt,
      signalId: p.signalId,
      breakevenAtR: p.breakevenDone ? null : (p.breakevenAtR ?? null),
      closeAt: p.closeAt ?? null,
    };
  }

  private buildState(): AccountState {
    const positions = this.state.positions.map((p) =>
      this.toPosition(p, this.feed.getPrice(p.symbol) ?? p.entryPrice),
    );
    return { summary: this.computeSummary(positions), positions, orders: [...this.state.orders] };
  }

  private computeSummary(
    positions = this.state.positions.map((p) => this.toPosition(p, this.feed.getPrice(p.symbol) ?? p.entryPrice)),
  ): AccountSummary {
    const s = this.state;
    const unrealized = positions.reduce((acc, p) => acc + p.unrealizedPnl, 0);
    const usedMargin = positions.reduce((acc, p) => acc + p.margin, 0);
    const orderMargin = s.orders.reduce((acc, o) => acc + o.margin, 0);
    const maintenance = positions.reduce((acc, p) => acc + p.notional * this.settings.maintenanceMarginRate, 0);
    const equity = s.walletBalance + unrealized;
    const today = startOfDay();
    const realizedTotal = s.trades.reduce((acc, t) => acc + t.realizedPnl, 0);
    const realizedToday = s.trades.filter((t) => t.closedAt >= today).reduce((acc, t) => acc + t.realizedPnl, 0);
    // Kısmi kapatmalar ayrı işlem satırıdır; kazanma oranı pozisyon bazında hesaplanır
    const byPosition = new Map<string, number>();
    for (const t of s.trades) byPosition.set(t.positionId, (byPosition.get(t.positionId) ?? 0) + t.realizedPnl);
    const wins = [...byPosition.values()].filter((v) => v > 0).length;

    return {
      mode: "paper",
      currency: "USDT",
      walletBalance: s.walletBalance,
      unrealizedPnl: unrealized,
      equity,
      usedMargin,
      orderMargin,
      availableBalance: Math.max(0, s.walletBalance - usedMargin - orderMargin),
      maintenanceMargin: maintenance,
      marginRatioPct: equity > 0 ? (maintenance / equity) * 100 : 0,
      initialBalance: s.initialBalance,
      realizedPnlTotal: realizedTotal,
      realizedPnlToday: realizedToday,
      feesTotal: s.feesTotal,
      tradeCount: byPosition.size,
      winRatePct: byPosition.size ? (wins / byPosition.size) * 100 : 0,
      returnPct: s.initialBalance > 0 ? ((equity - s.initialBalance) / s.initialBalance) * 100 : 0,
      updatedAt: Date.now(),
    };
  }

  private snapshot(): void {
    const sum = this.computeSummary();
    const last = this.state.equity[this.state.equity.length - 1];
    const point = { time: Date.now(), equity: sum.equity, walletBalance: sum.walletBalance };
    // Aynı saniyedeki noktaları birleştir (grafik zaman damgaları benzersiz olmalı)
    if (last && Math.floor(last.time / 1000) === Math.floor(point.time / 1000)) this.state.equity.pop();
    this.state.equity.push(point);
    if (this.state.equity.length > MAX_EQUITY_POINTS) {
      this.state.equity.splice(0, this.state.equity.length - MAX_EQUITY_POINTS);
    }
    this.persist();
  }

  private persist(): void {
    this.store.scheduleSave(() => this.state);
  }

  private notice(level: "info" | "warn" | "error", message: string): void {
    this.emit("notice", { level, message });
  }

  private freshState(initialBalance: number): PaperState {
    return {
      initialBalance,
      walletBalance: initialBalance,
      feesTotal: 0,
      positions: [],
      orders: [],
      trades: [],
      equity: [],
    };
  }
}

/** Bildirimler için okunur fiyat (anlamlı 6 basamak) */
function px(v: number): string {
  return Number(v.toPrecision(6)).toLocaleString("tr-TR", { maximumFractionDigits: 8 });
}

function sideTr(side: PositionSide): string {
  return side === "LONG" ? "LONG (al)" : "SHORT (sat)";
}
