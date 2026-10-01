"use client";

import { useEffect, useState } from "react";
import { canOfferPlan, describeTrack, INTERVAL_LABELS, type Interval, type TechnicalAnalysis, type Tone, type Verdict } from "@signal-lab/shared";
import { api } from "@/lib/api";
import { fmtPct, fmtPrice } from "@/lib/format";
import { setDraft, useStore } from "@/lib/store";
import { ConsensusBar, GateChecks } from "./SignalAction";

/** Karar yalnızca sinyal kapısından gelir (sunucu: verdictFromView) — orta/sağ panel ve liste aynı */
const VERDICT: Record<Verdict, { label: string; cls: string }> = {
  STRONG_BUY: { label: "GÜÇLÜ AL", cls: "v-strong-buy" },
  BUY: { label: "AL", cls: "v-buy" },
  NEUTRAL: { label: "BEKLE", cls: "v-neutral" },
  AVOID: { label: "UZAK DUR", cls: "v-sell" },
  SELL: { label: "SAT", cls: "v-sell" },
  STRONG_SELL: { label: "GÜÇLÜ SAT", cls: "v-strong-sell" },
};

const TONE_ICON: Record<Tone, string> = { bull: "▲", bear: "▼", neutral: "●" };

const TREND_TR = { UP: "Yukarı", DOWN: "Aşağı", NEUTRAL: "Yatay" } as const;

/** Seçili coin/aralık için teknik analizi yükler ve 15 saniyede bir tazeler. */
export function useAnalysis(symbol: string, interval: Interval): TechnicalAnalysis | null {
  const [analysis, setAnalysis] = useState<TechnicalAnalysis | null>(null);
  useEffect(() => {
    let cancelled = false;
    setAnalysis(null);
    const load = () =>
      api
        .analysis(symbol, interval)
        .then((a) => !cancelled && setAnalysis(a))
        .catch(() => {});
    void load();
    const t = setInterval(load, 15_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [symbol, interval]);
  return analysis;
}

export function AnalysisPanel({ analysis }: { analysis: TechnicalAnalysis | null }) {
  const live = useStore((s) => (analysis ? s.consensus[analysis.symbol] : undefined));
  if (!analysis) return <div className="empty">Teknik analiz hazırlanıyor…</div>;
  const a = analysis;
  const v = VERDICT[a.verdict];
  const c = live ?? a.consensus ?? null;
  const strongLook = a.verdict === "NEUTRAL" && !!c && c.label === "İZLE";
  const track = describeTrack(a.track);

  return (
    <div className="analysis">
      <div className="analysis-col">
        <div className={`verdict ${strongLook ? "v-watch" : v.cls}`}>
          <span className="verdict-label">{strongLook ? "Güçlü görünüm" : v.label}</span>
          <span className="verdict-tf">{c ? `${c.agree}/${c.total} bileşen uyumlu` : ""}</span>
        </div>
        {c && <ConsensusBar score={c.score} />}
        <div className="faint" style={{ fontSize: 11 }}>
          Karar sinyal kapısından gelir: AL yalnızca tüm kontroller geçince; GÜÇLÜ AL = A+ (ADX ≥ 25, kırılım veya 2+
          strateji, BTC aleyhte değil). Konsensüs %{c?.score ?? 0}.
        </div>
        <div className="analysis-headline">{a.headline}</div>
        <p className="analysis-summary">{a.summary}</p>
        <div className="analysis-meta num">
          <span title="Baskın yönü destekleyen bileşen sayısı / toplam bileşen">
            Bileşen uyumu %{a.confidence}
            {c ? ` (${c.agree}/${c.total})` : ""}
          </span>
          <span title="Bir mumda ortalama fiyat hareketi">
            Oynaklık:{" "}
            <b className={a.volatility.level === "high" ? "down" : a.volatility.level === "low" ? "muted" : ""}>
              {a.volatility.level === "high" ? "yüksek" : a.volatility.level === "low" ? "düşük" : "normal"}
            </b>
          </span>
        </div>
        {c && (
          <>
            <div className="analysis-title">Sinyal kapısı ({c.checks.filter((x) => x.ok).length}/{c.checks.length})</div>
            <GateChecks checks={c.checks} />
          </>
        )}
        <div className="track-box">
          <b>Bu coinin örneklem dışı karnesi (1s):</b> {track.text}
          {track.sufficient && a.track && (
            <>
              , işlem başına net <span className={a.track.expectancyPct >= 0 ? "up" : "down"}>{fmtPct(a.track.expectancyPct)}</span>
            </>
          )}
          <div className="faint" style={{ fontSize: 10, marginTop: 2 }}>
            Kuralların seçilmediği dönemde (Tem 2025 – Oca 2026), ücret + kayma düşülerek. Kazanç = yalnızca hedefe ulaşan
            işlem. Geçmiş, geleceğin garantisi değildir.
          </div>
        </div>
      </div>

      <div className="analysis-col">
        {c && (
          <>
            <div className="analysis-title" style={{ marginTop: 0 }}>
              Kontrol listesi — tüm analizler
            </div>
            <ul className="checklist">
              {c.items.map((it) => (
                <li key={it.key} className={`check ${it.vote > 0 ? "yes" : it.vote < 0 ? "no" : "mid"}`}>
                  <span className="ic">{it.vote > 0 ? "✓" : it.vote < 0 ? "✗" : "–"}</span>
                  <span className="lbl">
                    {it.label}
                    {it.trigger && it.vote !== 0 && <small>tetiklendi</small>}
                  </span>
                  <span className="det">
                    {it.detail}
                    {it.weight ? <small className="faint"> • ağırlık {it.weight}</small> : null}
                  </span>
                </li>
              ))}
            </ul>
            <div className="faint" style={{ fontSize: 11 }}>
              ✓ = AL yönünde, ✗ = SAT yönünde, – = nötr. Piyasa (BTC 4s):{" "}
              <b className={c.btcTrend === "UP" ? "up" : c.btcTrend === "DOWN" ? "down" : ""}>
                {c.btcTrend === "UP" ? "yukarı" : c.btcTrend === "DOWN" ? "aşağı" : "yatay"}
              </b>
              . Gün/hafta açılışı Binance saatine göredir (TR 03:00).
              {c.blockedBy ? ` Sinyal durumu: ${c.blockedBy}.` : " Sinyal koşulları sağlandı."}
            </div>
          </>
        )}
        <div className="analysis-title">Neden? (sade anlatım)</div>
        <ul className="points">
          {a.points.map((p) => (
            <li key={p.title} className={`point ${p.tone}`}>
              <span className="point-icon">{TONE_ICON[p.tone]}</span>
              <div>
                <b>{p.title}</b>
                <div>{p.text}</div>
              </div>
            </li>
          ))}
        </ul>
      </div>

      <div className="analysis-col">
        <div className="analysis-title">Zaman dilimleri</div>
        <div className="tf-grid">
          {a.timeframes.map((t) => (
            <div key={t.interval} className={`tf ${t.trend === "UP" ? "up" : t.trend === "DOWN" ? "down" : "muted"}`}>
              <span className="tf-name">{INTERVAL_LABELS[t.interval]}</span>
              <span className="tf-arrow">{t.trend === "UP" ? "▲" : t.trend === "DOWN" ? "▼" : "▬"}</span>
              <span className="tf-trend">{TREND_TR[t.trend]}</span>
            </div>
          ))}
        </div>

        <div className="analysis-title">Destek ve direnç</div>
        <div className="levels num">
          {a.levels.length === 0 && <div className="faint">Belirgin seviye yok</div>}
          {a.levels.map((l) => (
            <div key={`${l.kind}${l.price}`} className={`level ${l.kind}`}>
              <span title={l.kind === "support" ? "Taban: düşüşte alıcıların geldiği seviye" : "Tavan: yükselişte satıcıların geldiği seviye"}>
                {l.kind === "support" ? "Destek" : "Direnç"}
              </span>
              <span>{fmtPrice(l.price)}</span>
              <span className="faint">{fmtPct(l.distancePct)}</span>
              <span className="faint" title="Kaç kez test edildi">
                {"●".repeat(Math.min(5, l.touches))}
              </span>
            </div>
          ))}
          <div className="level current">
            <span>Fiyat</span>
            <span>{fmtPrice(a.price)}</span>
            <span />
            <span />
          </div>
        </div>

        {canOfferPlan(a) && a.plan ? (
          <div className={`plan ${a.plan.side === "LONG" ? "long" : "short"}`}>
            <div className="analysis-title" style={{ marginTop: 0 }}>
              İşlem planı
            </div>
            <div className="plan-row num">
              <span>Giriş</span>
              <b>{fmtPrice(a.plan.entry)}</b>
              <span className="down">Zarar kes</span>
              <b className="down">{fmtPrice(a.plan.stopLoss)}</b>
              <span className="up">Hedef</span>
              <b className="up">{fmtPrice(a.plan.takeProfit)}</b>
            </div>
            <p>{a.plan.note}</p>
            <button
              className={`btn ${a.plan.side === "LONG" ? "long" : "short"}`}
              onClick={() =>
                setDraft({
                  symbol: a.symbol,
                  side: a.plan!.side,
                  stopLoss: a.plan!.stopLoss,
                  takeProfit: a.plan!.takeProfit,
                  signalId: null,
                  confidence: a.track?.winRatePct ?? null,
                })
              }
            >
              Bu planı emir paneline aktar
            </button>
          </div>
        ) : (
          <div className="plan neutral">
            <b>Şu an işlem planı yok.</b> Alım koşulları oluştuğunda burada giriş, zarar kes ve hedef seviyeleri
            görünecek; sinyal gelirse grafikte yeşil ışık yanar.
          </div>
        )}
      </div>
    </div>
  );
}
