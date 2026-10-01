"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { type OrderType, type PositionSide } from "@signal-lab/shared";
import { api } from "@/lib/api";
import { baseAsset, fmtPct, fmtPrice, fmtQty, fmtUsd, priceDecimals } from "@/lib/format";
import { notify, refreshAccount, useStore } from "@/lib/store";

/** Varsayılan stop: sinyal planı yoksa 1.5 × ATR(1s) — sunucudaki plan kuralıyla aynı çarpan */
const DEFAULT_ATR_STOP = 1.5;
const DEFAULT_RR = 1.5;
/** Tahmini hesaplar için (sunucudaki varsayılanlarla aynı) */
const EST_TAKER_FEE = 0.0005;
const EST_MMR = 0.005;

export function OrderPanel({ symbol }: { symbol: string }) {
  const ticker = useStore((s) => s.tickers[symbol]);
  const summary = useStore((s) => s.account?.summary);
  const mode = useStore((s) => s.mode);
  const draft = useStore((s) => s.draft);

  const [side, setSide] = useState<PositionSide>("LONG");
  const [type, setType] = useState<OrderType>("MARKET");
  const [margin, setMargin] = useState("10");
  const [leverage, setLeverage] = useState(1);
  const maxLeverage = useStore((s) => s.maxLeverage);
  const allowShort = useStore((s) => s.allowShort);
  const view = useStore((s) => s.consensus[symbol]);
  const [limitPrice, setLimitPrice] = useState("");
  const [useSl, setUseSl] = useState(false);
  const [useTp, setUseTp] = useState(false);
  const [sl, setSl] = useState("");
  const [tp, setTp] = useState("");
  const [signalId, setSignalId] = useState<string | null>(null);
  const [signalConfidence, setSignalConfidence] = useState<number | null>(null);
  const [autoBe, setAutoBe] = useState(true);
  const [busy, setBusy] = useState(false);

  // Sembol değişince başka coine ait fiyat alanlarını temizle (sinyal taslağı varsa hemen ardından uygulanır)
  useEffect(() => {
    setSignalId(null);
    setSignalConfidence(null);
    setLimitPrice("");
    setUseSl(false);
    setUseTp(false);
    setSl("");
    setTp("");
  }, [symbol]);

  // Sinyalden "işlem aç" ile gelen taslağı uygula
  const appliedDraft = useRef<number | null>(null);
  useEffect(() => {
    if (!draft || draft.symbol !== symbol || appliedDraft.current === draft.nonce) return;
    appliedDraft.current = draft.nonce;
    const d = priceDecimals(draft.stopLoss ?? draft.takeProfit ?? 1);
    setSide(draft.side);
    setType("MARKET");
    setUseSl(draft.stopLoss != null);
    setUseTp(draft.takeProfit != null);
    setSl(draft.stopLoss != null ? draft.stopLoss.toFixed(d) : "");
    setTp(draft.takeProfit != null ? draft.takeProfit.toFixed(d) : "");
    setSignalId(draft.signalId);
    setSignalConfidence(draft.confidence ?? null);
  }, [draft, symbol]);

  const marketPrice = ticker?.price ?? 0;
  const entry = type === "LIMIT" ? Number(limitPrice) || 0 : marketPrice;
  const marginNum = Number(margin) || 0;
  const notional = marginNum * leverage;
  const qty = entry > 0 ? notional / entry : 0;
  const fee = notional * EST_TAKER_FEE;
  const dir = side === "LONG" ? 1 : -1;
  const liq = entry > 0 ? entry * (1 - dir * (1 / leverage) + dir * EST_MMR) : 0;
  const slNum = useSl ? Number(sl) || 0 : 0;
  const tpNum = useTp ? Number(tp) || 0 : 0;
  const lossAtSl = slNum && entry ? (slNum - entry) * qty * dir : null;
  const gainAtTp = tpNum && entry ? (tpNum - entry) * qty * dir : null;
  const rr = lossAtSl && gainAtTp && lossAtSl < 0 ? gainAtTp / -lossAtSl : null;
  const available = summary?.availableBalance ?? 0;

  const problems = useMemo(() => {
    const out: string[] = [];
    if (!marketPrice) out.push("Fiyat bekleniyor");
    if (marginNum <= 0) out.push("Teminat girin");
    else if (marginNum + fee > available + 1e-9) out.push("Yetersiz bakiye");
    if (type === "LIMIT" && !(Number(limitPrice) > 0)) out.push("Limit fiyatı girin");
    if (slNum && entry && (side === "LONG" ? slNum >= entry : slNum <= entry))
      out.push(`SL ${side === "LONG" ? "girişin altında" : "girişin üstünde"} olmalı`);
    if (tpNum && entry && (side === "LONG" ? tpNum <= entry : tpNum >= entry))
      out.push(`TP ${side === "LONG" ? "girişin üstünde" : "girişin altında"} olmalı`);
    if (slNum && liq && (side === "LONG" ? slNum <= liq : slNum >= liq)) out.push("SL likidasyon fiyatının ötesinde");
    return out;
  }, [marketPrice, marginNum, fee, available, type, limitPrice, slNum, tpNum, entry, side, liq]);

  const setPct = (pct: number) => {
    const max = available / (1 + leverage * EST_TAKER_FEE);
    setMargin(Math.max(0, Math.floor(max * pct * 100) / 100).toString());
  };

  /** SL/TP'yi giriş fiyatından yüzde uzaklıkla doldurur. */
  /** Plan seviyeleri: kapıyı geçmiş sinyal planı varsa o; yoksa 1.5×ATR(1s) stop ve 1.5R hedef */
  const planLevels = (() => {
    if (view?.passed && view.plan) {
      return { sl: view.plan.stopLoss, tp: view.plan.takeProfit, label: "Sinyal planı" };
    }
    const ref = marketPrice || 0;
    if (view?.atr && ref) {
      const dir = side === "LONG" ? 1 : -1;
      const risk = DEFAULT_ATR_STOP * view.atr;
      return { sl: ref - dir * risk, tp: ref + dir * DEFAULT_RR * risk, label: `${DEFAULT_ATR_STOP}×ATR (1s)` };
    }
    return null;
  })();
  const applyPlan = () => {
    if (!planLevels) return;
    const d = priceDecimals(planLevels.sl);
    setUseSl(true);
    setUseTp(true);
    setSl(planLevels.sl.toFixed(d));
    setTp(planLevels.tp.toFixed(d));
  };
  // Coin değişince ve plan oluşunca varsayılan olarak plan/ATR stop'u kullan (manuel düzenleme serbest)
  const planKey = planLevels ? `${symbol}:${planLevels.label}` : "";
  const appliedPlan = useRef("");
  useEffect(() => {
    if (!planKey || appliedPlan.current === planKey || signalId) return;
    appliedPlan.current = planKey;
    applyPlan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planKey]);



  async function submit() {
    if (problems.length || busy) return;
    if (mode === "binance") {
      const ok = window.confirm(
        `GERÇEK EMİR: ${symbol} ${side} ${leverage}x, teminat ${fmtUsd(marginNum)} USDT (${fmtUsd(notional)} USDT büyüklük). Onaylıyor musunuz?`,
      );
      if (!ok) return;
    }
    setBusy(true);
    try {
      await api.openPosition({
        symbol,
        side,
        type,
        margin: marginNum,
        leverage,
        limitPrice: type === "LIMIT" ? Number(limitPrice) : undefined,
        stopLoss: slNum || null,
        takeProfit: tpNum || null,
        signalId,
        breakevenAtR: autoBe && slNum ? 1 : null,
      });
      notify("success", `${symbol} ${side} emri gönderildi`);
      setSignalId(null);
      await refreshAccount();
    } catch (err) {
      notify("error", (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel order-panel">
      <div className="segment" role="tablist" aria-label="Yön" style={allowShort ? undefined : { gridTemplateColumns: "1fr" }}>
        <button className={side === "LONG" ? "active-long" : ""} onClick={() => setSide("LONG")}>
          Long / Al
        </button>
        {allowShort && (
          <button className={side === "SHORT" ? "active-short" : ""} onClick={() => setSide("SHORT")}>
            Short / Sat
          </button>
        )}
      </div>

      <div className="segment" aria-label="Emir tipi">
        <button className={type === "MARKET" ? "active" : ""} onClick={() => setType("MARKET")}>
          Piyasa
        </button>
        <button
          className={type === "LIMIT" ? "active" : ""}
          onClick={() => {
            setType("LIMIT");
            if (!limitPrice && marketPrice) setLimitPrice(marketPrice.toFixed(priceDecimals(marketPrice)));
          }}
        >
          Limit
        </button>
      </div>

      {signalId && (
        <div className="signal-hint">
          <span>
            Sinyalden dolduruldu
            {signalConfidence != null ? ` • tahmini başarı %${Math.round(signalConfidence)}` : ""}
          </span>
          <button onClick={() => setSignalId(null)}>bağı kaldır</button>
        </div>
      )}

      {type === "LIMIT" && (
        <div className="field">
          <label htmlFor="limit-price">
            <span>Limit fiyatı</span>
            <span className="num">Piyasa: {fmtPrice(marketPrice)}</span>
          </label>
          <div className="input-wrap">
            <input
              id="limit-price"
              inputMode="decimal"
              value={limitPrice}
              onChange={(e) => setLimitPrice(e.target.value)}
            />
            <span className="suffix">USDT</span>
          </div>
        </div>
      )}

      <div className="field">
        <label htmlFor="margin">
          <span>Teminat</span>
          <span className="num">Kullanılabilir: {fmtUsd(available)} USDT</span>
        </label>
        <div className="input-wrap">
          <input id="margin" inputMode="decimal" value={margin} onChange={(e) => setMargin(e.target.value)} />
          <span className="suffix">USDT</span>
        </div>
        <div className="pct-row">
          {[0.1, 0.25, 0.5, 1].map((p) => (
            <button key={p} onClick={() => setPct(p)}>
              %{p * 100}
            </button>
          ))}
        </div>
      </div>

      <div className="field">
        <div className="label">
          <span>Kaldıraç</span>
          <span>Isolated</span>
        </div>
        <div className="lev-row">
          <input
            type="range"
            min={1}
            max={maxLeverage}
            value={leverage}
            onChange={(e) => setLeverage(Number(e.target.value))}
            aria-label="Kaldıraç"
          />
          <span className="lev-value num">{leverage}x</span>
        </div>
        <div className="lev-presets">
          {Array.from({ length: maxLeverage }, (_, k) => k + 1).map((l) => (
            <button key={l} className={leverage === l ? "active" : ""} onClick={() => setLeverage(l)}>
              {l}x
            </button>
          ))}
        </div>
      </div>

      <div className="field">
        <label className="toggle">
          <input type="checkbox" checked={useSl} onChange={(e) => setUseSl(e.target.checked)} />
          Stop loss
          {planLevels && (
            <span style={{ marginLeft: "auto" }}>
              <button
                type="button"
                className="btn sm ghost"
                title="Stop ve hedefi plana göre doldur"
                onClick={(e) => (e.preventDefault(), applyPlan())}
              >
                {planLevels.label}
              </button>
            </span>
          )}
        </label>
        {useSl && (
          <div className="input-wrap">
            <input inputMode="decimal" value={sl} onChange={(e) => setSl(e.target.value)} aria-label="Stop loss fiyatı" />
            <span className="suffix">{entry && slNum ? fmtPct(((slNum - entry) / entry) * 100) : "USDT"}</span>
          </div>
        )}
      </div>

      <div className="field">
        <label className="toggle">
          <input type="checkbox" checked={useTp} onChange={(e) => setUseTp(e.target.checked)} />
          Take profit
        </label>
        {useTp && (
          <div className="input-wrap">
            <input inputMode="decimal" value={tp} onChange={(e) => setTp(e.target.value)} aria-label="Take profit fiyatı" />
            <span className="suffix">{entry && tpNum ? fmtPct(((tpNum - entry) / entry) * 100) : "USDT"}</span>
          </div>
        )}
      </div>

      <label className="toggle" title="Fiyat, risk ettiğiniz mesafe kadar (1R) kâra geçince stop otomatik olarak giriş fiyatının biraz üstüne taşınır. Böylece işlem en kötü küçük bir kârla kapanır.">
        <input type="checkbox" checked={autoBe} onChange={(e) => setAutoBe(e.target.checked)} disabled={!useSl} />
        Oto başa baş: 1R kârda stop'u girişe taşı
        <span className="faint" style={{ marginLeft: "auto", fontSize: 10 }}>
          {useSl ? "önerilir" : "SL gerekli"}
        </span>
      </label>

      <div className="summary-list num">
        <div>
          <span>Pozisyon büyüklüğü</span>
          <span>{fmtUsd(notional)} USDT</span>
        </div>
        <div>
          <span>Miktar</span>
          <span>
            {fmtQty(qty)} {baseAsset(symbol)}
          </span>
        </div>
        <div>
          <span>Tahmini likidasyon</span>
          <span className="warn">{entry ? fmtPrice(liq) : "—"}</span>
        </div>
        <div>
          <span>Tahmini ücret</span>
          <span>~{fmtUsd(fee)} USDT</span>
        </div>
        {lossAtSl != null && (
          <div>
            <span>SL'de zarar</span>
            <span className="down">
              {fmtUsd(lossAtSl, { sign: true })} ({fmtPct(marginNum ? (lossAtSl / marginNum) * 100 : 0)})
            </span>
          </div>
        )}
        {gainAtTp != null && (
          <div>
            <span>TP'de kâr</span>
            <span className="up">
              {fmtUsd(gainAtTp, { sign: true })} ({fmtPct(marginNum ? (gainAtTp / marginNum) * 100 : 0)})
            </span>
          </div>
        )}
        {rr != null && (
          <div>
            <span>Risk / Ödül</span>
            <span>1 : {rr.toFixed(2)}</span>
          </div>
        )}
      </div>

      <button
        className={`submit ${side === "LONG" ? "long" : "short"}`}
        disabled={problems.length > 0 || busy}
        onClick={submit}
        title={problems.join(" • ")}
      >
        {busy
          ? "Gönderiliyor…"
          : problems.length
            ? problems[0]
            : `${side === "LONG" ? "Long aç" : "Short aç"} • ${baseAsset(symbol)} ${leverage}x`}
      </button>
    </div>
  );
}
