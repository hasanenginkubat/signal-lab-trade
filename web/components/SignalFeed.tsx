"use client";

import { describeTrack, isActionableSignal, type Signal, type SignalStatus } from "@signal-lab/shared";
import { baseAsset, fmtPct, fmtPrice, fmtTime } from "@/lib/format";
import { executeOneClick } from "@/lib/oneClick";
import { QualityBadge } from "./SignalAction";
import { setDraft, useStore } from "@/lib/store";

export const STATUS_LABEL: Record<SignalStatus, { label: string; cls: string }> = {
  OPEN: { label: "Açık", cls: "open" },
  TP_HIT: { label: "Hedef ✓", cls: "tp" },
  SL_HIT: { label: "Stop ✗", cls: "sl" },
  EXPIRED: { label: "Süresi doldu", cls: "" },
  MISSED: { label: "Kaçırıldı (dolmadı)", cls: "" },
};

interface Props {
  onSelectSymbol: (symbol: string) => void;
  filterSymbol?: string | null;
  onlyOpen?: boolean;
}

export function SignalFeed({ onSelectSymbol, filterSymbol, onlyOpen }: Props) {
  const signals = useStore((s) => s.signals);
  const tickers = useStore((s) => s.tickers);
  const list = signals.filter((s) => (!filterSymbol || s.symbol === filterSymbol) && (!onlyOpen || s.status === "OPEN"));

  if (list.length === 0) {
    return (
      <div className="empty">
        {filterSymbol ? "Bu coin için sinyal yok." : "Henüz sinyal yok."} Sinyaller {""}
        mum kapanışlarında, birden fazla gösterge aynı yönü gösterdiğinde üretilir.
      </div>
    );
  }

  return (
    <div>
      {list.slice(0, 150).map((s) => (
        <SignalCard key={s.id} signal={s} price={tickers[s.symbol]?.price} onSelectSymbol={onSelectSymbol} />
      ))}
    </div>
  );
}

function SignalCard({
  signal: s,
  price,
  onSelectSymbol,
}: {
  signal: Signal;
  price?: number;
  onSelectSymbol: (symbol: string) => void;
}) {
  const long = s.side === "LONG";
  const onlyAPlus = useStore((st) => st.settings.onlyAPlus);
  const status =
    s.status === "SL_HIT" && s.stopMoved
      ? { label: "Başa baş (stop girişte)", cls: "" }
      : s.status === "OPEN" && s.stopMoved
        ? { label: "Stop girişte", cls: "tp" }
        : s.status === "OPEN" && s.entryLimit && s.fillPrice == null
          ? { label: "Giriş bekleniyor", cls: "open" }
          : STATUS_LABEL[s.status];
  const livePct = s.status === "OPEN" && price ? ((price - s.price) / s.price) * 100 * (long ? 1 : -1) : s.resultPct;

  const trade = (e: React.MouseEvent) => {
    e.stopPropagation();
    onSelectSymbol(s.symbol);
    setDraft({
      symbol: s.symbol,
      side: s.side,
      stopLoss: s.stopLoss,
      takeProfit: s.takeProfit,
      signalId: s.id,
      confidence: s.confidence ?? null,
    });
  };

  return (
    <div className="signal-card" onClick={() => onSelectSymbol(s.symbol)}>
      <div className="top">
        <span className={`side-tag ${long ? "long" : "short"}`}>{s.label ?? (long ? "AL" : "SAT")}</span>
        <QualityBadge signal={s} />
        <b style={{ color: "var(--text-strong)" }}>{baseAsset(s.symbol)}</b>
        <span className="faint">{s.interval}</span>
        <span className={`status-pill ${status.cls}`}>{status.label}</span>
        <span className="faint num" style={{ marginLeft: "auto", fontSize: 11 }}>
          {fmtTime(s.createdAt)}
        </span>
      </div>
      <div className="top num" style={{ fontSize: 11 }}>
        <span>
          <span className="faint">Giriş </span>
          {fmtPrice(s.price)}
        </span>
        <span className="down">SL {fmtPrice(s.stopLoss)}</span>
        <span className="up">TP {fmtPrice(s.takeProfit)}</span>
        <span className={livePct == null ? "" : livePct >= 0 ? "up" : "down"} style={{ marginLeft: "auto" }}>
          {fmtPct(livePct)}
        </span>
      </div>
      <div className="top">
        <span className="faint" style={{ fontSize: 10 }} title="Bu kalite seviyesinin örneklem dışı karnesi. Kazanç = yalnızca hedefe ulaşan işlem.">
          Karne: {describeTrack(s.history).text}
          {s.riskReward ? ` • R:R ${s.riskReward.toFixed(2)}` : ""}
        </span>
        {s.status === "OPEN" && !isActionableSignal(s, onlyAPlus) && (
          <span className="faint" style={{ marginLeft: "auto", fontSize: 10 }} title="Seçici mod: işlem butonu yalnızca A+ sinyallerde">
            A (izle) — bilgi amaçlı
          </span>
        )}
        {s.status === "OPEN" && isActionableSignal(s, onlyAPlus) && (
          <span className="btn-row" style={{ marginLeft: "auto" }}>
            <button className="btn sm ghost" onClick={trade} title="SL/TP'yi emir paneline aktar, büyüklüğü kendin seç">
              Forma aktar
            </button>
            <button
              className={`btn sm ${long ? "long" : "short"}`}
              title="Risk ayarına göre büyüklük hesaplanır; SL, TP ve oto başa baş dahil"
              onClick={(e) => {
                e.stopPropagation();
                void executeOneClick({
                  symbol: s.symbol,
                  side: s.side,
                  stopLoss: s.stopLoss,
                  takeProfit: s.takeProfit,
                  signalId: s.id,
                  entryLimit: s.entryLimit,
                  entryValidUntil: s.entryValidUntil,
                });
              }}
            >
              {s.entryLimit && (s.entryValidUntil ?? 0) > Date.now() ? "Akıllı AL" : `Tek tıkla ${long ? "AL" : "SAT"}`}
            </button>
          </span>
        )}
      </div>
      {s.checklist && (
        <div className="faint" style={{ fontSize: 11 }}>
          {s.checklist.filter((c) => c.vote === (long ? 1 : -1)).length}/{s.checklist.length} koşul{" "}
          {long ? "AL" : "SAT"} diyor
          {s.checklist.some((c) => c.vote === (long ? -1 : 1)) &&
            ` • karşı: ${s.checklist.filter((c) => c.vote === (long ? -1 : 1)).map((c) => c.label).join(", ")}`}
        </div>
      )}
      <div className="reasons">{s.reasons.join(" • ")}</div>
    </div>
  );
}
