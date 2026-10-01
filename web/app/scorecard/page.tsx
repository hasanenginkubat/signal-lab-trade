"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { Scorecard } from "@signal-lab/shared";
import { BacktestSection } from "@/components/BacktestSection";
import { ScorecardTable } from "@/components/ScorecardTable";
import { SignalFeed } from "@/components/SignalFeed";
import { api } from "@/lib/api";
import { fmtPct } from "@/lib/format";
import { useStore } from "@/lib/store";

export default function ScorecardPage() {
  const router = useRouter();
  const signals = useStore((s) => s.signals);
  const [card, setCard] = useState<Scorecard | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .scorecard()
      .then((c) => {
        setCard(c);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, [signals]);

  const o = card?.overall;
  const closed = o ? o.total - o.open - o.missed : 0;

  return (
    <main className="page">
      <div className="page-head">
        <h1>Sinyal karnesi</h1>
        <span className="muted" style={{ fontSize: 12, maxWidth: 640 }}>
          Her sinyal backtest ile aynı kurallarla takip edilir: akıllı giriş dolmazsa "kaçırıldı"; fiyat önce hedefe değerse
          kazanç, stopa değerse kayıp; 1R kârdan sonra stop girişe çekilir ve orada kapanırsa başa baş. Sonuçlar kaldıraçsız,
          ücret + kayma sonrası fiyat değişimidir.
        </span>
      </div>
      {error && <div className="box empty">{error}</div>}
      <BacktestSection />
      <h1 style={{ fontSize: 16, marginTop: 8 }}>Canlı sinyallerin sonuçları</h1>
      {o && (
        <div className="cards num">
          <div className="card">
            <span className="k">Toplam sinyal</span>
            <span className="v">{o.total}</span>
            <span className="sub muted">{o.open} açık</span>
          </div>
          <div className="card">
            <span className="k">Kazanma oranı (yalnızca hedef)</span>
            <span className="v">{closed >= 30 ? `${o.winRatePct.toFixed(1)}%` : closed ? `yetersiz veri (n=${closed})` : "—"}</span>
            <span className="sub muted">
              {o.wins} kazanç / {o.breakevens} başa baş / {o.losses} kayıp • {o.missed} kaçırıldı
            </span>
          </div>
          <div className="card">
            <span className="k">Ortalama sonuç</span>
            <span className={`v ${o.avgResultPct >= 0 ? "up" : "down"}`}>{fmtPct(o.avgResultPct)}</span>
            <span className="sub muted">Sinyal başına</span>
          </div>
          <div className="card">
            <span className="k">Toplam sonuç</span>
            <span className={`v ${o.totalResultPct >= 0 ? "up" : "down"}`}>{fmtPct(o.totalResultPct)}</span>
            <span className="sub muted">{o.expired} sinyalin süresi doldu</span>
          </div>
        </div>
      )}
      {card && (
        <>
          <div className="two-col">
            <ScorecardTable title="Yöne göre" rows={card.bySide} />
            <ScorecardTable title="Zaman aralığına göre" rows={card.byInterval} />
          </div>
          <ScorecardTable title="Coin bazında" rows={card.bySymbol} symbolKeys />
        </>
      )}
      <div className="box">
        <div className="box-head">Son sinyaller</div>
        <div style={{ maxHeight: 600, overflow: "auto" }}>
          <SignalFeed onSelectSymbol={(s) => router.push(`/${s}`)} />
        </div>
      </div>
    </main>
  );
}
