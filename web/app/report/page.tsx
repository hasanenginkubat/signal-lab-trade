"use client";

import { useEffect, useState } from "react";
import type { MarketReport } from "@signal-lab/shared";
import { ConsensusBadge, GuardBanner, QualityBadge } from "@/components/SignalAction";
import { api } from "@/lib/api";
import { baseAsset, fmtPrice, fmtTime } from "@/lib/format";
import { focusSymbol, notify, useStore } from "@/lib/store";

export default function ReportPage() {
  const [report, setReport] = useState<MarketReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const signalsVersion = useStore((s) => s.signals.length);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      api
        .report()
        .then((r) => {
          if (cancelled) return;
          setReport(r);
          setError(null);
        })
        .catch((e: Error) => !cancelled && setError(e.message));
    void load();
    const t = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [signalsVersion]);

  async function copy() {
    if (!report) return;
    try {
      await navigator.clipboard.writeText(report.text);
      notify("success", "Rapor panoya kopyalandı");
    } catch {
      notify("error", "Kopyalanamadı");
    }
  }

  if (error) return <main className="page"><div className="box empty">{error}</div></main>;
  if (!report) return <main className="page"><div className="box empty">Rapor hazırlanıyor…</div></main>;
  const r = report;
  const tone = r.regime.tone === "bull" ? "v-strong-buy" : r.regime.tone === "bear" ? "v-strong-sell" : "v-neutral";

  return (
    <main className="page report">
      <div className="page-head">
        <div>
          <h1>Günlük Rapor</h1>
          <span className="faint" style={{ fontSize: 12 }}>
            {fmtTime(r.generatedAt)} • dakikada bir güncellenir
          </span>
        </div>
        <button className="btn" onClick={copy}>
          Metni kopyala
        </button>
      </div>

      <div className={`verdict ${tone}`} style={{ padding: "16px 20px" }}>
        <span className="verdict-label">Piyasa rejimi: {r.regime.label}</span>
      </div>
      <div className="box" style={{ padding: "16px 20px" }}>
        <h2 className="report-headline">{r.headline}</h2>
        {r.paragraphs.map((p) => (
          <p key={p} className="report-p">
            {p}
          </p>
        ))}
      </div>

      <GuardBanner guard={r.guard} />

      <div className="two-col">
        <div className="box">
          <div className="box-head">En güçlü kurulumlar</div>
          {r.top.length === 0 && <div className="empty">AL bölgesine yakın coin yok.</div>}
          {r.top.map((v) => (
            <button key={v.symbol} className="report-row" onClick={() => focusSymbol(v.symbol)}>
              <b>{baseAsset(v.symbol)}</b>
              <ConsensusBadge view={v} />
              <span className="faint">{v.blockedBy ?? "sinyal koşulları sağlandı"}</span>
            </button>
          ))}
        </div>
        <div className="box">
          <div className="box-head">Uzak durulacaklar</div>
          {r.avoid.length === 0 && <div className="empty">Belirgin şekilde zayıf coin yok.</div>}
          {r.avoid.map((v) => (
            <button key={v.symbol} className="report-row" onClick={() => focusSymbol(v.symbol)}>
              <b>{baseAsset(v.symbol)}</b>
              <ConsensusBadge view={v} />
              <span className="faint">{v.agree}/{v.total} koşul aşağı</span>
            </button>
          ))}
        </div>
      </div>

      <div className="box">
        <div className="box-head">Aktif sinyaller ve analist notları</div>
        {r.activeSignals.length === 0 && <div className="empty">Şu an açık sinyal yok. Sinyal gelince bildirim alacaksınız.</div>}
        {r.activeSignals.map((s) => (
          <details key={s.id} className="analyst-note report-signal">
            <summary>
              <span className={`side-tag ${s.side === "LONG" ? "long" : "short"}`}>{s.label ?? "AL"}</span>{" "}
              <QualityBadge signal={s} /> <b>{baseAsset(s.symbol)}</b>{" "}
              <span className="num faint">
                giriş {fmtPrice(s.entryLimit ?? s.price)} • stop {fmtPrice(s.stopLoss)} • hedef {fmtPrice(s.takeProfit)} • {fmtTime(s.createdAt)}
              </span>
            </summary>
            <pre>{s.note ?? s.reasons.join("\n")}</pre>
            <button className="btn sm" onClick={() => focusSymbol(s.symbol)}>
              Grafikte aç
            </button>
          </details>
        ))}
      </div>

      <div className="faint" style={{ fontSize: 11, lineHeight: 1.6 }}>
        Bu rapor otomatik üretilir ve yatırım tavsiyesi değildir. Kurallar 8 aylık gerçek veride test edilmiştir; geçmiş
        sonuçlar geleceği garanti etmez.
      </div>
    </main>
  );
}
