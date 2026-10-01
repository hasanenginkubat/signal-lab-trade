"use client";

import { useSyncExternalStore } from "react";
import type {
  AccountMode,
  AccountState,
  ConsensusView,
  Interval,
  Opportunity,
  PositionSide,
  ServerMessage,
  Signal,
  SymbolBias,
  Ticker,
} from "@signal-lab/shared";
import { describeTrack, isActionableSignal, persistableSettings, restoreSettings } from "@signal-lab/shared";
import { api } from "./api";
import { socket, type SocketState } from "./socket";

export interface NoticeAction {
  label: string;
  run: () => void;
  tone?: "long" | "short" | "default";
}

export interface Notice {
  id: number;
  level: "info" | "warn" | "error" | "success";
  message: string;
  actions?: NoticeAction[];
}

export interface TradeSettings {
  /** Tek tıkla işlemde stop olursa riske edilecek bakiye yüzdesi */
  riskPct: number;
  /** Tercih edilen kaldıraç (likidasyon güvenliği için gerekirse düşürülür) */
  leverage: number;
  /** Seçici mod: sadece A+ kalite sinyaller için bildirim ve işlem butonu. Kalıcı değil: her açılışta sunucu varsayılanı (A+) */
  onlyAPlus: boolean;
  /** Zaman stopu (saat): işlem bu süre sonunda hâlâ açıksa kapatılır */
  maxHoldHours: number;
}

/** Sinyalden ya da grafikten emir panelini doldurmak için taslak. */
export interface OrderDraft {
  symbol: string;
  side: PositionSide;
  stopLoss: number | null;
  takeProfit: number | null;
  signalId: string | null;
  /** Sinyalin ölçülmüş tahmini başarısı (%) */
  confidence?: number | null;
  nonce: number;
}

export interface AppState {
  mode: AccountMode | null;
  symbols: string[];
  signalIntervals: Interval[];
  primaryInterval: Interval;
  tickers: Record<string, Ticker>;
  /** anahtar: `${symbol}:${interval}` */
  biases: Record<string, SymbolBias>;
  account: AccountState | null;
  signals: Signal[];
  socket: SocketState;
  binance: "connected" | "connecting" | "disconnected";
  notices: Notice[];
  draft: OrderDraft | null;
  /** İşlem geçmişi değiştiğinde artar; tablolar yeniden yükler */
  tradesVersion: number;
  /** Gün içi uygunluğa göre sıralı coin listesi */
  opportunities: Opportunity[];
  /** Hızlı panel (bakiye + pozisyonlar) açık mı */
  quickPanel: boolean;
  /** Hızlı panelde "tümünü kapat" onayı gösteriliyor mu */
  quickConfirm: boolean;
  /** Coin → tüm analizlerin birleşik görünümü */
  consensus: Record<string, ConsensusView>;
  settings: TradeSettings;
  /** Short işlemlere izin var mı (kapalıyken short butonu ve "sat" tarafı gizlenir) */
  allowShort: boolean;
  /** İzin verilen en yüksek kaldıraç */
  maxLeverage: number;
  consensusThreshold: number;
  /** Binance coin minimumları (min. büyüklük USDT / min. adet) */
  minOrder: Record<string, { minNotional: number; minQty: number }>;
  /** Başka sayfadan/bildirimden terminalde açılması istenen coin */
  focusSymbol: { symbol: string; nonce: number } | null;
}

let state: AppState = {
  mode: null,
  symbols: [],
  signalIntervals: [],
  primaryInterval: "1h",
  tickers: {},
  biases: {},
  account: null,
  signals: [],
  socket: "closed",
  binance: "connecting",
  notices: [],
  draft: null,
  tradesVersion: 0,
  opportunities: [],
  quickPanel: false,
  quickConfirm: false,
  consensus: {},
  settings: { riskPct: 1, leverage: 1, onlyAPlus: true, maxHoldHours: 48 },
  allowShort: false,
  maxLeverage: 5,
  consensusThreshold: 70,
  focusSymbol: null,
  minOrder: {},
};

const listeners = new Set<() => void>();

function setState(patch: Partial<AppState> | ((s: AppState) => Partial<AppState>)): void {
  const next = typeof patch === "function" ? patch(state) : patch;
  state = { ...state, ...next };
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useStore<T>(selector: (s: AppState) => T): T {
  return useSyncExternalStore(
    subscribe,
    () => selector(state),
    () => selector(state),
  );
}

export function getState(): AppState {
  return state;
}

// ---------- eylemler ----------

let noticeId = 0;
export function notify(level: Notice["level"], message: string, actions?: NoticeAction[]): void {
  const id = ++noticeId;
  setState((s) => ({ notices: [...s.notices.slice(-4), { id, level, message, actions }] }));
  // Eylem butonlu bildirimler daha uzun kalır
  setTimeout(() => dismissNotice(id), actions?.length ? 60_000 : level === "error" ? 8000 : 5000);
}

export function setSettings(patch: Partial<TradeSettings>): void {
  setState((s) => ({ settings: { ...s.settings, ...patch } }));
  try {
    localStorage.setItem("sl.trade.v2", JSON.stringify(persistableSettings(state.settings)));
  } catch {
    /* depolama kapalı olabilir */
  }
}

export function focusSymbol(symbol: string): void {
  setState({ focusSymbol: { symbol, nonce: Date.now() } });
}

export function clearFocus(): void {
  setState({ focusSymbol: null });
}

export function dismissNotice(id: number): void {
  setState((s) => ({ notices: s.notices.filter((n) => n.id !== id) }));
}

export function setDraft(draft: Omit<OrderDraft, "nonce">): void {
  setState({ draft: { ...draft, nonce: Date.now() } });
}

export function setQuickPanel(open: boolean, confirmCloseAll = false): void {
  setState({ quickPanel: open, quickConfirm: open && confirmCloseAll });
}

export function setAccount(account: AccountState): void {
  setState({ account });
}

export async function refreshAccount(): Promise<void> {
  try {
    setAccount(await api.account());
  } catch {
    /* bağlantı durumu ayrıca gösteriliyor */
  }
}

// ---------- başlatma ----------

let started = false;

export function ensureStarted(): void {
  if (started || typeof window === "undefined") return;
  started = true;

  try {
    // Seçici mod tarayıcıdan geri yüklenmez: yenileyince A+ moduna döner
    const saved = JSON.parse(localStorage.getItem("sl.trade.v2") ?? "null") as Partial<TradeSettings> | null;
    setState((s) => ({ settings: restoreSettings(s.settings, saved, true) }));
  } catch {
    /* yoksay */
  }
  socket.onState((s) => setState({ socket: s }));
  socket.on(handleMessage);
  socket.start();

  void loadInitial();
}

async function loadInitial(): Promise<void> {
  try {
    const [config, overview, signals, views] = await Promise.all([
      api.config(),
      api.symbols(),
      api.signals({ limit: 300 }),
      api.consensusAll().catch(() => []),
    ]);
    const tickers: Record<string, Ticker> = {};
    const biases: Record<string, SymbolBias> = {};
    for (const o of overview) {
      if (o.ticker) tickers[o.symbol] = o.ticker;
      if (o.bias) biases[`${o.symbol}:${o.bias.interval}`] = o.bias;
    }
    setState((s) => ({
      mode: config.mode,
      symbols: config.symbols,
      signalIntervals: config.signalIntervals,
      primaryInterval: config.primaryInterval,
      minOrder: config.minOrder ?? {},
      allowShort: config.allowShort ?? false,
      maxLeverage: config.maxLeverage ?? 5,
      consensusThreshold: config.consensusThreshold ?? 70,
      // Kayıtlı kaldıraç sınırı aşıyorsa kırp (varsayılan 1x, en fazla maxLeverage)
      settings: {
        ...s.settings,
        leverage: Math.min(Math.max(1, s.settings.leverage), config.maxLeverage ?? 5),
        onlyAPlus: config.aPlusOnly ?? true,
      },
      tickers: { ...tickers, ...s.tickers },
      biases: { ...biases, ...s.biases },
      signals,
      consensus: { ...Object.fromEntries(views.map((v) => [v.symbol, v])), ...s.consensus },
    }));
  } catch (err) {
    notify("error", (err as Error).message);
    // Sunucu ayağa kalkınca tekrar dene
    started = false;
    setTimeout(() => {
      started = true;
      void loadInitial();
    }, 5000);
  }
}

function handleMessage(msg: ServerMessage): void {
  switch (msg.type) {
    case "hello":
      // Sunucu (yeniden) bağlandığında seçici mod varsayılana döner
      setState((s) => ({
        mode: msg.data.mode,
        symbols: msg.data.symbols,
        signalIntervals: msg.data.signalIntervals,
        settings: { ...s.settings, onlyAPlus: msg.data.aPlusOnly ?? true },
      }));
      break;
    case "tickers": {
      const tickers = { ...state.tickers };
      for (const t of msg.data) tickers[t.symbol] = t;
      setState({ tickers });
      break;
    }
    case "bias":
      setState((s) => ({ biases: { ...s.biases, [`${msg.data.symbol}:${msg.data.interval}`]: msg.data } }));
      break;
    case "account":
      setState({ account: msg.data });
      break;
    case "signal": {
      const sig = msg.data;
      setState((s) => ({ signals: [sig, ...s.signals].slice(0, 500) }));
      // Seçici modda A kalite sinyaller listeye girer ama bildirim göndermez
      if (!isActionableSignal(sig, state.settings.onlyAPlus)) break;
      notify(
        sig.side === "LONG" ? "success" : "warn",
        `${sig.side === "LONG" ? "🟢" : "🔴"} ${sig.label ?? (sig.side === "LONG" ? "AL" : "SAT")}${sig.quality ? ` [${sig.quality}]` : ""}: ${sig.symbol}` +
          (sig.consensus != null ? ` • koşulların %${Math.abs(sig.consensus)}'i uyumlu` : "") +
          ` • karne: ${describeTrack(sig.history).text}`,
        [
          {
            label: sig.entryLimit ? "Akıllı AL" : sig.side === "LONG" ? "Tek tıkla AL" : "Tek tıkla SAT",
            tone: sig.side === "LONG" ? "long" : "short",
            run: () => {
              void import("./oneClick").then((m) =>
                m.executeOneClick({
                  symbol: sig.symbol,
                  side: sig.side,
                  stopLoss: sig.stopLoss,
                  takeProfit: sig.takeProfit,
                  signalId: sig.id,
                  entryLimit: sig.entryLimit,
                  entryValidUntil: sig.entryValidUntil,
                }),
              );
            },
          },
          { label: "Grafikte gör", run: () => focusSymbol(sig.symbol) },
        ],
      );
      break;
    }
    case "consensus":
      setState((s) => ({ consensus: { ...s.consensus, [msg.data.symbol]: msg.data } }));
      break;
    case "exitAlert": {
      const a = msg.data;
      const pos = state.account?.positions.filter((p) => p.symbol === a.symbol && p.side === "LONG") ?? [];
      notify(
        "error",
        `🔴 ${a.message}`,
        pos.length
          ? [
              {
                label: `Long pozisyonu kapat (${pos.length})`,
                tone: "short",
                run: () => {
                  void api.closeAll(a.symbol).then(refreshAccount).catch((e: Error) => notify("error", e.message));
                },
              },
              { label: "Grafikte gör", run: () => focusSymbol(a.symbol) },
            ]
          : [{ label: "Grafikte gör", run: () => focusSymbol(a.symbol) }],
      );
      break;
    }
    case "signalUpdate": {
      const next = msg.data;
      const prev = state.signals.find((x) => x.id === next.id);
      setState((s) => ({ signals: s.signals.map((x) => (x.id === next.id ? next : x)) }));
      if (!prev || !isActionableSignal(next, state.settings.onlyAPlus)) break;
      const coin = next.symbol.replace(/USDT$/, "");
      const pct = next.resultPct != null ? `${next.resultPct >= 0 ? "+" : ""}${next.resultPct.toFixed(2)}%` : "";
      if (prev.status === "OPEN" && next.status === "TP_HIT") {
        notify("success", `🔴 SAT noktası geldi: ${coin} hedefe (${next.takeProfit.toPrecision(6)}) ulaştı ${pct}. Pozisyonun varsa hedef emriyle otomatik satıldı.`);
      } else if (prev.status === "OPEN" && next.status === "SL_HIT") {
        notify(
          next.stopMoved ? "info" : "warn",
          next.stopMoved
            ? `${coin}: stop girişte devreye girdi, başa baş kapandı ${pct} (ücret + kayma kadar eksi).`
            : `${coin}: stop oldu ${pct}. Planın parçası — bir sonraki sinyali bekle.`,
        );
      } else if (prev.status === "OPEN" && next.status === "MISSED") {
        notify("info", `${coin}: akıllı giriş emri dolmadı (fiyat geri çekilmeden yükseldi ya da süre doldu) — işlem açılmadı.`);
      } else if (prev.status === "OPEN" && next.status === "EXPIRED") {
        notify("info", `${coin}: sinyal 48 saatte sonuçlanmadı, kapandı ${pct}.`);
      } else if (!prev.stopMoved && next.stopMoved) {
        notify("success", `🛡️ ${coin}: fiyat 1R kâra geçti — stop girişe çekildi; bundan sonra en kötü ihtimalle ücret kadar eksiyle kapanır.`);
      }
      break;
    }
    case "trade":
      setState((s) => ({ tradesVersion: s.tradesVersion + 1 }));
      break;
    case "notice":
      notify(msg.data.level, msg.data.message);
      break;
    case "status":
      setState({ binance: msg.data.binance });
      break;
    case "opportunities":
      setState({ opportunities: msg.data });
      break;
    case "candle":
      // Mumlar doğrudan grafik bileşeninde dinlenir
      break;
  }
}
