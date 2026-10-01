import { createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import type {
  AccountState,
  AccountSummary,
  EquityPoint,
  OpenPositionRequest,
  PendingOrder,
  Position,
  PositionSide,
  Trade,
  UpdateProtectionRequest,
} from "@signal-lab/shared";
import { fetchSymbolFilters, type SymbolFilters } from "../binance/rest";
import { JsonStore } from "../db/jsonStore";
import { pnl, startOfDay, validateOpenRequest, validateProtection } from "./math";
import type { PriceFeed } from "./paperBroker";
import { TradingError, type Broker, type BrokerEvents } from "./types";

export interface BinanceSettings {
  apiKey: string;
  apiSecret: string;
  restBase: string;
  recvWindow: number;
  /** İzin verilen en yüksek kaldıraç */
  maxLeverage?: number;
}

type Params = Record<string, string | number | boolean | undefined>;

interface RawPositionRisk {
  symbol: string;
  positionSide: string;
  positionAmt: string;
  entryPrice: string;
  markPrice: string;
  unRealizedProfit: string;
  liquidationPrice: string;
  isolatedMargin: string;
  isolatedWallet?: string;
  notional: string;
  initialMargin: string;
  maintMargin: string;
  updateTime: number;
}

interface RawAccount {
  totalWalletBalance: string;
  totalUnrealizedProfit: string;
  totalMarginBalance: string;
  totalPositionInitialMargin: string;
  totalOpenOrderInitialMargin: string;
  totalMaintMargin: string;
  availableBalance: string;
}

interface RawOrder {
  orderId: number;
  symbol: string;
  side: "BUY" | "SELL";
  type: string;
  price: string;
  origQty: string;
  reduceOnly: boolean;
  closePosition: boolean;
  time: number;
}

interface RawAlgoOrder {
  algoId: number;
  symbol: string;
  side: "BUY" | "SELL";
  orderType: string;
  triggerPrice: string;
  closePosition: boolean;
  algoStatus: string;
}

interface RawIncome {
  symbol: string;
  incomeType: string;
  income: string;
  time: number;
  tranId: number;
  tradeId: string;
}

const POSITION_POLL_MS = 3000;
const ORDER_POLL_MS = 10_000;
const EQUITY_SNAPSHOT_MS = 5 * 60_000;

/**
 * Gerçek Binance USDⓈ-M Futures hesabı. Tek yönlü (one-way) pozisyon modu ve ISOLATED
 * marjin varsayar. SL/TP emirleri Binance'in koşullu emir servisine
 * (`/fapi/v1/algoOrder`, closePosition=true) gönderilir, yani sunucu kapalıyken de çalışır.
 *
 * Pozisyon kimliği sembolün kendisidir (tek yönlü modda sembol başına tek pozisyon olur).
 */
export class BinanceBroker extends EventEmitter<BrokerEvents> implements Broker {
  readonly mode = "binance" as const;

  private filters = new Map<string, SymbolFilters>();
  private timeOffset = 0;
  private account: RawAccount | null = null;
  private positions: RawPositionRisk[] = [];
  private orders: RawOrder[] = [];
  private algoOrders: RawAlgoOrder[] = [];
  private leverageBySymbol = new Map<string, number>();
  /** Limit emir dolunca kurulacak SL/TP */
  private pendingProtection = new Map<string, UpdateProtectionRequest>();
  private openedAt = new Map<string, number>();
  /** Otomatik başa baş takibi (sembol → ayar) */
  private breakeven = new Map<string, { atR: number; risk: number; entry: number; side: PositionSide }>();
  /** Zaman stopu: sembol → kapanış zamanı (ms) */
  private closeAt = new Map<string, number>();
  /** Limit emir dolunca başlatılacak zaman stopu süresi */
  private pendingMaxHold = new Map<string, number>();
  /** Limit emir → dolmadan fiyat bu seviyeye gelirse iptal */
  private cancelLevels = new Map<string, { level: number; side: PositionSide }>();
  private timers: NodeJS.Timeout[] = [];
  private equity: EquityPoint[];
  private readonly equityStore: JsonStore<EquityPoint[]>;
  private initialBalance: number | null = null;
  private trades: Trade[] = [];
  private tradesFetchedAt = 0;

  constructor(
    private readonly feed: PriceFeed,
    private readonly settings: BinanceSettings,
    private readonly symbols: string[],
    dataDir: string,
  ) {
    super();
    if (!settings.apiKey || !settings.apiSecret) {
      throw new Error("TRADING_MODE=binance için BINANCE_API_KEY ve BINANCE_API_SECRET gerekli");
    }
    this.equityStore = new JsonStore<EquityPoint[]>(dataDir, "binance-equity.json");
    this.equity = this.equityStore.load([]);
    this.initialBalance = this.equity[0]?.walletBalance ?? null;
  }

  async start(): Promise<void> {
    const time = await this.request<{ serverTime: number }>("GET", "/fapi/v1/time", {}, false);
    this.timeOffset = time.serverTime - Date.now();
    this.filters = await fetchSymbolFilters(this.symbols);

    await this.refreshPositions();
    await this.refreshOrders();
    if (this.initialBalance == null && this.account) {
      this.initialBalance = Number(this.account.totalWalletBalance);
    }
    this.snapshot();

    this.feed.on("price", (symbol) => {
      if (this.positions.some((p) => p.symbol === symbol)) this.emit("changed");
    });
    this.timers.push(
      setInterval(() => void this.refreshPositions().catch((e) => this.pollError(e)), POSITION_POLL_MS),
      setInterval(() => void this.refreshOrders().catch((e) => this.pollError(e)), ORDER_POLL_MS),
      setInterval(() => this.snapshot(), EQUITY_SNAPSHOT_MS),
    );
    console.info(`[binance] gerçek hesap bağlandı (${this.settings.restBase})`);
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.equityStore.flush(() => this.equity);
  }

  async getState(): Promise<AccountState> {
    const positions = this.mapPositions();
    const orders = this.mapOrders();
    return { summary: this.summary(positions), positions, orders };
  }

  async openPosition(req: OpenPositionRequest): Promise<Position | PendingOrder> {
    const symbol = req.symbol?.toUpperCase();
    const filter = this.filters.get(symbol);
    if (!filter) throw new TradingError(`Bilinmeyen sembol: ${req.symbol}`);
    const market = this.feed.getPrice(symbol);
    if (!market) throw new TradingError("Bu sembol için henüz fiyat yok");

    const refPrice = req.type === "LIMIT" ? Number(req.limitPrice) : market;
    validateOpenRequest({ ...req, symbol }, refPrice, this.settings.maxLeverage ?? 5);

    const existing = this.positions.find((p) => p.symbol === symbol && Number(p.positionAmt) !== 0);
    if (existing) {
      const existingSide: PositionSide = Number(existing.positionAmt) > 0 ? "LONG" : "SHORT";
      if (existingSide !== req.side) {
        throw new TradingError(`${symbol} için açık ${existingSide} pozisyon var; önce onu kapatın`);
      }
    }

    const quantity = floorToStep((req.margin * req.leverage) / refPrice, filter.stepSize);
    if (quantity < filter.minQty || quantity * refPrice < filter.minNotional) {
      throw new TradingError(
        `Emir çok küçük: en az ${filter.minNotional} USDT büyüklük / ${filter.minQty} adet gerekli`,
      );
    }

    await this.request("POST", "/fapi/v1/marginType", { symbol, marginType: "ISOLATED" }).catch((err) => {
      // -4046: zaten ISOLATED. Açık pozisyon varken değiştirilemez (-4048) — mevcut modla devam.
      if (!/-404[68]/.test(String((err as Error).message))) throw err;
    });
    await this.request("POST", "/fapi/v1/leverage", { symbol, leverage: req.leverage });
    this.leverageBySymbol.set(symbol, req.leverage);

    const side = req.side === "LONG" ? "BUY" : "SELL";
    const params: Params = { symbol, side, quantity: fmt(quantity, filter.stepSize), newOrderRespType: "RESULT" };
    if (req.type === "LIMIT") {
      // GTD: Binance süre dolunca emri kendisi iptal eder (en az 10 dk sonrası olmalı)
      const gtd = req.expiresAt && req.expiresAt > Date.now() + 11 * 60_000 ? req.expiresAt : null;
      Object.assign(params, {
        type: "LIMIT",
        timeInForce: gtd ? "GTD" : "GTC",
        goodTillDate: gtd ?? undefined,
        price: fmt(roundToStep(refPrice, filter.tickSize), filter.tickSize),
      });
    } else {
      params.type = "MARKET";
    }
    const order = await this.request<RawOrder & { avgPrice: string; status: string }>("POST", "/fapi/v1/order", params);

    const protection = { stopLoss: req.stopLoss ?? null, takeProfit: req.takeProfit ?? null };
    if (req.breakevenAtR && protection.stopLoss != null) {
      const entry = Number(order.avgPrice) || refPrice;
      this.breakeven.set(symbol, {
        atR: req.breakevenAtR,
        risk: Math.abs(entry - protection.stopLoss),
        entry,
        side: req.side,
      });
    }
    if (req.maxHoldMs) {
      if (order.status === "FILLED") this.closeAt.set(symbol, Date.now() + req.maxHoldMs);
      else this.pendingMaxHold.set(symbol, req.maxHoldMs);
    }
    if (order.status === "FILLED") {
      if (!existing) this.openedAt.set(symbol, Date.now());
      await this.refreshPositions();
      await this.placeProtection(symbol, req.side, protection);
      await this.refreshOrders();
      this.emit("notice", {
        level: "info",
        message: `${symbol} ${req.side} ${req.leverage}x açıldı @ ${Number(order.avgPrice) || market}`,
      });
      this.emit("changed");
      const pos = this.mapPositions().find((p) => p.symbol === symbol);
      if (!pos) throw new TradingError("Emir doldu ancak pozisyon henüz görünmüyor, birkaç saniye sonra yenileyin");
      return pos;
    }

    if (protection.stopLoss != null || protection.takeProfit != null) this.pendingProtection.set(symbol, protection);
    if (req.cancelIfPriceReaches != null) {
      this.cancelLevels.set(`${symbol}:${order.orderId}`, { level: req.cancelIfPriceReaches, side: req.side });
    }
    await this.refreshOrders();
    this.emit("notice", { level: "info", message: `${symbol} limit emri verildi @ ${params.price}` });
    this.emit("changed");
    const pending = this.mapOrders().find((o) => o.id === `${symbol}:${order.orderId}`);
    if (!pending) throw new TradingError("Emir verildi ancak listede görünmüyor, birkaç saniye sonra yenileyin");
    return pending;
  }

  async closePosition(id: string, percent = 100): Promise<Trade | null> {
    const pos = this.positions.find((p) => p.symbol === id && Number(p.positionAmt) !== 0);
    if (!pos) throw new TradingError("Pozisyon bulunamadı", 404);
    if (!(percent > 0 && percent <= 100)) throw new TradingError("Kapatma oranı 1-100 arasında olmalı");
    const filter = this.filters.get(pos.symbol);
    const amt = Number(pos.positionAmt);
    const step = filter?.stepSize ?? 0.001;
    const qty = percent >= 100 ? Math.abs(amt) : floorToStep((Math.abs(amt) * percent) / 100, step);
    if (qty <= 0) throw new TradingError("Kapatılacak miktar çok küçük");

    await this.request("POST", "/fapi/v1/order", {
      symbol: pos.symbol,
      side: amt > 0 ? "SELL" : "BUY",
      type: "MARKET",
      quantity: fmt(qty, step),
      reduceOnly: "true",
    });
    if (percent >= 100) {
      await this.cancelProtection(pos.symbol);
      this.openedAt.delete(pos.symbol);
      this.breakeven.delete(pos.symbol);
    }
    await this.refreshPositions();
    await this.refreshOrders();
    this.tradesFetchedAt = 0;
    this.emit("notice", { level: "info", message: `${pos.symbol} pozisyonu %${percent} kapatıldı` });
    this.emit("changed");
    return null;
  }

  async updateProtection(id: string, req: UpdateProtectionRequest): Promise<Position> {
    const pos = this.mapPositions().find((p) => p.id === id);
    if (!pos) throw new TradingError("Pozisyon bulunamadı", 404);
    validateProtection(pos.side, pos.markPrice, req.stopLoss ?? null, req.takeProfit ?? null);
    await this.cancelProtection(pos.symbol);
    await this.placeProtection(pos.symbol, pos.side, req);
    await this.refreshOrders();
    this.emit("changed");
    return this.mapPositions().find((p) => p.id === id) ?? pos;
  }

  async cancelOrder(id: string): Promise<void> {
    const [symbol, orderId] = id.split(":");
    if (!symbol || !orderId) throw new TradingError("Geçersiz emir kimliği");
    await this.request("DELETE", "/fapi/v1/order", { symbol, orderId });
    this.pendingProtection.delete(symbol);
    await this.refreshOrders();
    this.emit("changed");
  }

  async getTrades(limit = 200): Promise<Trade[]> {
    if (Date.now() - this.tradesFetchedAt > 15_000) {
      const income = await this.request<RawIncome[]>("GET", "/fapi/v1/income", {
        incomeType: "REALIZED_PNL",
        limit: 1000,
      });
      // Binance gerçekleşen K/Z'yi dolum bazında verir; giriş/çıkış ayrıntıları bu uç noktada yoktur
      this.trades = income.map((i) => ({
        id: String(i.tranId),
        positionId: i.symbol,
        symbol: i.symbol,
        side: "LONG" as PositionSide,
        entryPrice: 0,
        exitPrice: 0,
        quantity: 0,
        leverage: this.leverageBySymbol.get(i.symbol) ?? 0,
        margin: 0,
        realizedPnl: Number(i.income),
        fees: 0,
        roePct: 0,
        openedAt: i.time,
        closedAt: i.time,
        reason: "MANUAL" as const,
        signalId: null,
      }));
      this.tradesFetchedAt = Date.now();
    }
    return this.trades.slice(-limit).reverse();
  }

  async getEquityHistory(): Promise<EquityPoint[]> {
    const s = this.summary(this.mapPositions());
    return [...this.equity, { time: Date.now(), equity: s.equity, walletBalance: s.walletBalance }];
  }

  // ---------- yardımcılar ----------

  private async refreshPositions(): Promise<void> {
    const [account, positions] = await Promise.all([
      this.request<RawAccount>("GET", "/fapi/v3/account", {}),
      this.request<RawPositionRisk[]>("GET", "/fapi/v3/positionRisk", {}),
    ]);
    this.account = account;
    this.positions = positions.filter((p) => Number(p.positionAmt) !== 0);
    await this.checkBreakeven();
    await this.checkCancelLevels();
    await this.checkTimeStops();

    for (const [symbol, protection] of this.pendingProtection) {
      const pos = this.positions.find((p) => p.symbol === symbol);
      if (!pos) continue;
      this.pendingProtection.delete(symbol);
      const side: PositionSide = Number(pos.positionAmt) > 0 ? "LONG" : "SHORT";
      await this.placeProtection(symbol, side, protection).catch((e) => this.pollError(e));
    }
    this.emit("changed");
  }

  /** Zaman stopu: süresi dolan pozisyonları piyasa fiyatından kapatır; dolan limitlerin süresini başlatır. */
  private async checkTimeStops(): Promise<void> {
    for (const [symbol, ms] of this.pendingMaxHold) {
      if (this.positions.some((p) => p.symbol === symbol)) {
        this.closeAt.set(symbol, Date.now() + ms);
        this.pendingMaxHold.delete(symbol);
      } else if (!this.orders.some((o) => o.symbol === symbol)) this.pendingMaxHold.delete(symbol);
    }
    for (const [symbol, at] of this.closeAt) {
      if (!this.positions.some((p) => p.symbol === symbol)) {
        this.closeAt.delete(symbol);
        continue;
      }
      if (Date.now() < at) continue;
      this.closeAt.delete(symbol);
      try {
        await this.closePosition(symbol, 100);
        this.emit("notice", { level: "info", message: `${symbol} zaman stopu: 48 saatte sonuçlanmadı, piyasa fiyatından kapatıldı` });
      } catch (err) {
        this.pollError(err);
      }
    }
  }

  /** Dolmadan hedefe kaçan limit emirleri iptal eder. */
  private async checkCancelLevels(): Promise<void> {
    for (const [key, c] of this.cancelLevels) {
      const [symbol, orderId] = key.split(":");
      if (!this.orders.some((o) => `${o.symbol}:${o.orderId}` === key)) {
        this.cancelLevels.delete(key);
        continue;
      }
      const price = this.feed.getPrice(symbol);
      if (!price || !(c.side === "LONG" ? price >= c.level : price <= c.level)) continue;
      this.cancelLevels.delete(key);
      try {
        await this.request("DELETE", "/fapi/v1/order", { symbol, orderId });
        this.pendingProtection.delete(symbol);
        this.emit("notice", { level: "info", message: `${symbol} limit emri iptal edildi: fiyat dolmadan hedefe kaçtı` });
      } catch (err) {
        this.pollError(err);
      }
    }
  }

  private async checkBreakeven(): Promise<void> {
    for (const [symbol, be] of this.breakeven) {
      const pos = this.positions.find((p) => p.symbol === symbol);
      if (!pos) {
        this.breakeven.delete(symbol);
        continue;
      }
      const price = this.feed.getPrice(symbol) ?? Number(pos.markPrice);
      const long = be.side === "LONG";
      const trigger = be.entry + (long ? 1 : -1) * be.atR * be.risk;
      if (!(long ? price >= trigger : price <= trigger)) continue;
      this.breakeven.delete(symbol);
      const current = this.mapPositions().find((p) => p.symbol === symbol);
      // Backtest ile aynı: stop tam girişe
      const stopLoss = be.entry;
      try {
        await this.cancelProtection(symbol);
        await this.placeProtection(symbol, be.side, { stopLoss, takeProfit: current?.takeProfit ?? null });
        this.emit("notice", { level: "info", message: `${symbol} ${be.atR}R kâra geçti — stop başa baş seviyesine taşındı` });
      } catch (err) {
        this.pollError(err);
      }
    }
  }

  private async refreshOrders(): Promise<void> {
    const [orders, algo] = await Promise.all([
      this.request<RawOrder[]>("GET", "/fapi/v1/openOrders", {}),
      this.request<RawAlgoOrder[] | { orders?: RawAlgoOrder[] }>("GET", "/fapi/v1/openAlgoOrders", {}),
    ]);
    this.orders = orders.filter((o) => o.type === "LIMIT" && !o.reduceOnly);
    this.algoOrders = Array.isArray(algo) ? algo : (algo.orders ?? []);
  }

  private async placeProtection(symbol: string, side: PositionSide, req: UpdateProtectionRequest): Promise<void> {
    const tick = this.filters.get(symbol)?.tickSize ?? 0.01;
    const closeSide = side === "LONG" ? "SELL" : "BUY";
    const place = (type: "STOP_MARKET" | "TAKE_PROFIT_MARKET", price: number) =>
      this.request("POST", "/fapi/v1/algoOrder", {
        algoType: "CONDITIONAL",
        symbol,
        side: closeSide,
        type,
        triggerPrice: fmt(roundToStep(price, tick), tick),
        closePosition: "true",
        workingType: "MARK_PRICE",
        priceProtect: "true",
      });
    if (req.stopLoss != null) await place("STOP_MARKET", req.stopLoss);
    if (req.takeProfit != null) await place("TAKE_PROFIT_MARKET", req.takeProfit);
  }

  private async cancelProtection(symbol: string): Promise<void> {
    await this.refreshOrders();
    const targets = this.algoOrders.filter(
      (o) => o.symbol === symbol && (o.orderType === "STOP_MARKET" || o.orderType === "TAKE_PROFIT_MARKET"),
    );
    for (const o of targets) {
      await this.request("DELETE", "/fapi/v1/algoOrder", { algoId: o.algoId }).catch((e) => this.pollError(e));
    }
  }

  private mapPositions(): Position[] {
    return this.positions.map((p) => {
      const amt = Number(p.positionAmt);
      const side: PositionSide = amt > 0 ? "LONG" : "SHORT";
      const qty = Math.abs(amt);
      const entry = Number(p.entryPrice);
      const mark = this.feed.getPrice(p.symbol) ?? Number(p.markPrice);
      const margin = Number(p.isolatedWallet ?? 0) || Number(p.isolatedMargin) || Number(p.initialMargin);
      const unrealized = pnl(side, entry, mark, qty);
      const initial = Number(p.initialMargin);
      const leverage =
        this.leverageBySymbol.get(p.symbol) ?? (initial > 0 ? Math.round(Math.abs(Number(p.notional)) / initial) : 1);
      const algos = this.algoOrders.filter((o) => o.symbol === p.symbol);
      const sl = algos.find((o) => o.orderType === "STOP_MARKET");
      const tp = algos.find((o) => o.orderType === "TAKE_PROFIT_MARKET");
      return {
        id: p.symbol,
        symbol: p.symbol,
        side,
        entryPrice: entry,
        markPrice: mark,
        quantity: qty,
        leverage,
        margin,
        notional: qty * mark,
        unrealizedPnl: unrealized,
        roePct: margin > 0 ? (unrealized / margin) * 100 : 0,
        liquidationPrice: Number(p.liquidationPrice),
        stopLoss: sl ? Number(sl.triggerPrice) : null,
        takeProfit: tp ? Number(tp.triggerPrice) : null,
        openedAt: this.openedAt.get(p.symbol) ?? p.updateTime,
        signalId: null,
        breakevenAtR: this.breakeven.get(p.symbol)?.atR ?? null,
        closeAt: this.closeAt.get(p.symbol) ?? null,
      };
    });
  }

  private mapOrders(): PendingOrder[] {
    return this.orders.map((o) => {
      const leverage = this.leverageBySymbol.get(o.symbol) ?? 1;
      const price = Number(o.price);
      const protection = this.pendingProtection.get(o.symbol);
      return {
        id: `${o.symbol}:${o.orderId}`,
        symbol: o.symbol,
        side: o.side === "BUY" ? "LONG" : "SHORT",
        type: "LIMIT",
        price,
        margin: (price * Number(o.origQty)) / leverage,
        leverage,
        stopLoss: protection?.stopLoss ?? null,
        takeProfit: protection?.takeProfit ?? null,
        createdAt: o.time,
        signalId: null,
      };
    });
  }

  private summary(positions: Position[]): AccountSummary {
    const a = this.account;
    const wallet = Number(a?.totalWalletBalance ?? 0);
    const unrealized = positions.reduce((acc, p) => acc + p.unrealizedPnl, 0);
    const equity = wallet + unrealized;
    const maint = Number(a?.totalMaintMargin ?? 0);
    const initial = this.initialBalance ?? wallet;
    const today = startOfDay();
    const realizedTotal = this.trades.reduce((acc, t) => acc + t.realizedPnl, 0);
    const realizedToday = this.trades.filter((t) => t.closedAt >= today).reduce((acc, t) => acc + t.realizedPnl, 0);
    const wins = this.trades.filter((t) => t.realizedPnl > 0).length;
    return {
      mode: "binance",
      currency: "USDT",
      walletBalance: wallet,
      unrealizedPnl: unrealized,
      equity,
      usedMargin: Number(a?.totalPositionInitialMargin ?? 0),
      orderMargin: Number(a?.totalOpenOrderInitialMargin ?? 0),
      availableBalance: Number(a?.availableBalance ?? 0),
      maintenanceMargin: maint,
      marginRatioPct: equity > 0 ? (maint / equity) * 100 : 0,
      initialBalance: initial,
      realizedPnlTotal: realizedTotal,
      realizedPnlToday: realizedToday,
      feesTotal: 0,
      tradeCount: this.trades.length,
      winRatePct: this.trades.length ? (wins / this.trades.length) * 100 : 0,
      returnPct: initial > 0 ? ((equity - initial) / initial) * 100 : 0,
      updatedAt: Date.now(),
    };
  }

  private snapshot(): void {
    if (!this.account) return;
    const s = this.summary(this.mapPositions());
    this.equity.push({ time: Date.now(), equity: s.equity, walletBalance: s.walletBalance });
    if (this.equity.length > 5000) this.equity.splice(0, this.equity.length - 5000);
    this.equityStore.scheduleSave(() => this.equity);
  }

  private pollError(err: unknown): void {
    console.error("[binance]", (err as Error).message);
  }

  private async request<T>(method: string, path: string, params: Params, signed = true): Promise<T> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) qs.set(k, String(v));
    if (signed) {
      qs.set("timestamp", String(Date.now() + this.timeOffset));
      qs.set("recvWindow", String(this.settings.recvWindow));
      qs.set("signature", createHmac("sha256", this.settings.apiSecret).update(qs.toString()).digest("hex"));
    }
    const res = await fetch(`${this.settings.restBase}${path}?${qs}`, {
      method,
      headers: { "X-MBX-APIKEY": this.settings.apiKey },
      signal: AbortSignal.timeout(10_000),
    });
    const text = await res.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { msg: text.slice(0, 200) };
    }
    if (!res.ok) {
      const { code, msg } = body as { code?: number; msg?: string };
      throw new TradingError(`Binance hatası (${code ?? res.status}): ${msg ?? "bilinmeyen hata"}`, 400);
    }
    return body as T;
  }
}

function decimals(step: number): number {
  const s = step.toString();
  if (s.includes("e-")) return Number(s.split("e-")[1]);
  return s.includes(".") ? s.split(".")[1].length : 0;
}

function floorToStep(value: number, step: number): number {
  const d = decimals(step);
  return Number((Math.floor(value / step + 1e-9) * step).toFixed(d));
}

function roundToStep(value: number, step: number): number {
  const d = decimals(step);
  return Number((Math.round(value / step) * step).toFixed(d));
}

function fmt(value: number, step: number): string {
  return value.toFixed(decimals(step));
}
