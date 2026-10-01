"use client";

import { useMemo } from "react";
import { isActionableSignal, type Signal } from "@signal-lab/shared";
import { baseAsset, fmtDuration, fmtPct, fmtPrice } from "@/lib/format";
import { useStore } from "@/lib/store";
import { QualityBadge } from "./SignalAction";

type State = { label: string; cls: "buy" | "wait" | "hold" | "late" | "done"; hint: string };

/** Sinyalin şu anki durumu: alınabilir mi, kaçtı mı, pozisyonda mıyız? */
export function signalState(s: Signal, price: number | undefined, hasPosition: boolean, hasOrder: boolean): State {
  const entry = s.entryLimit ?? s.price;
  const risk = Math.abs(entry - (s.initialStopLoss ?? s.stopLoss));
  if (hasPosition) return { label: "Pozisyondasın", cls: "hold", hint: `Satış otomatik: hedef ${fmtPrice(s.takeProfit)} ya da stop ${fmtPrice(s.stopLoss)}` };
  if (hasOrder) return { label: "Emir bekliyor", cls: "wait", hint: `Fiyat ${fmtPrice(entry)} seviyesine inince alınacak` };
  if (!price) return { label: "…", cls: "wait", hint: "" };
  if (price >= s.takeProfit) return { label: "Hedefe ulaştı", cls: "done", hint: "Bu fırsat bitti" };
  if (price <= s.stopLoss) return { label: "Stop altında", cls: "done", hint: "Senaryo bozuldu, alınmaz" };
  // Girişten 0.5R'den fazla uzaklaştıysa risk/ödül bozulur: kovalamayın
  if (price > entry + 0.5 * risk) return { label: "Kaçtı — kovalama", cls: "late", hint: "Fiyat giriş seviyesinden çok uzaklaştı; geri çekilme beklenebilir" };
  return { label: "AL bölgesinde", cls: "buy", hint: s.entryLimit && (s.entryValidUntil ?? 0) > Date.now() ? `Akıllı giriş ${fmtPrice(entry)}` : "Güncel fiyattan alınabilir" };
}

export function ActiveSignals({ onSelect, selected }: { onSelect: (s: string) => void; selected: string }) {
  const signals = useStore((s) => s.signals);
  const tickers = useStore((s) => s.tickers);
  const onlyAPlus = useStore((s) => s.settings.onlyAPlus);
  const positions = useStore((s) => s.account?.positions);
  const orders = useStore((s) => s.account?.orders);
  const consensus = useStore((s) => s.consensus);

  const active = useMemo(
    () =>
      signals
        .filter((s) => s.status === "OPEN" && s.kind === "consensus")
        // Seçici modda A kaliteler "A (izle)" olarak listenin sonunda bilgi amaçlı kalır
        .sort((a, b) => (onlyAPlus ? Number(b.quality === "A+") - Number(a.quality === "A+") : 0) || b.createdAt - a.createdAt),
    [signals, onlyAPlus],
  );
  const actionable = active.filter((s) => isActionableSignal(s, onlyAPlus)).length;
  const lastScan = useMemo(() => Math.max(0, ...Object.values(consensus).map((v) => v.updatedAt)), [consensus]);
  const btcDaily = consensus["BTCUSDT"]?.btcDailyTrend;

  return (
    <div className="active-signals">
      <div className="as-head">
        <span>
          <span className="dot ok" /> AL sinyalleri {actionable > 0 && <span className="count">{actionable}</span>}
        </span>
        <span className="faint" title="Konsensüs her 15 dakikada, sinyaller her saat başı mum kapanışında; fiyatlar saniyede bir güncellenir">
          {lastScan ? `tarama ${new Date(lastScan).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" })}` : "taranıyor…"}
        </span>
      </div>
      {active.length === 0 ? (
        <div className="as-empty">
          {btcDaily && btcDaily !== "UP"
            ? "Şu an AL sinyali yok. BTC günlükte yükselişte değil — sistem bilerek bekliyor."
            : "Şu an AL sinyali yok. Sinyaller saat başı kontrol edilir; gelince burada ve bildirimde görünür."}
        </div>
      ) : (
        active.slice(0, 8).map((s) => {
          const price = tickers[s.symbol]?.price;
          const hasPosition = !!positions?.some((p) => p.symbol === s.symbol);
          const st: State =
            !hasPosition && !isActionableSignal(s, onlyAPlus)
              ? { label: "İzle", cls: "wait", hint: "Seçici mod: A kalite sinyal yalnızca bilgi amaçlı; işlem önerilmez" }
              : signalState(s, price, hasPosition, !!orders?.some((o) => o.symbol === s.symbol));
          const entry = s.entryLimit ?? s.price;
          return (
            <button
              key={s.id}
              className={`as-row ${st.cls}${s.symbol === selected ? " active" : ""}`}
              onClick={() => onSelect(s.symbol)}
              title={st.hint}
            >
              <div className="as-top">
                <span className={`as-dot ${st.cls}`} />
                <b>{baseAsset(s.symbol)}</b>
                <QualityBadge signal={s} />
                <span className={`as-state ${st.cls}`}>{st.label}</span>
                <span className="faint num as-age">{fmtDuration(Date.now() - s.createdAt)}</span>
              </div>
              <div className="as-levels num">
                <span>
                  <i>AL</i> {fmtPrice(entry)}
                </span>
                <span className="down">
                  <i>SAT</i> {fmtPrice(s.takeProfit)}
                </span>
                <span className="faint">
                  <i>Stop</i> {fmtPrice(s.stopLoss)}
                </span>
                {price && <span className={price >= s.price ? "up" : "down"}>{fmtPct(((price - s.price) / s.price) * 100)}</span>}
              </div>
            </button>
          );
        })
      )}
    </div>
  );
}
