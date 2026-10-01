"use client";

import { useEffect, useState } from "react";
import { describeTrack, type BacktestSummary, type PeriodReport } from "@signal-lab/shared";
import { api } from "@/lib/api";
import { baseAsset, fmtPct, fmtTime } from "@/lib/format";

const day = (t: number) => new Date(t).toLocaleDateString("tr-TR", { day: "2-digit", month: "short", year: "numeric" });

function PeriodCard({ title, subtitle, r }: { title: string; subtitle: string; r: PeriodReport | null }) {
  if (!r) {
    return (
      <div className="box" style={{ padding: 16 }}>
        <b>{title}</b>
        <div className="faint" style={{ marginTop: 6 }}>Hesaplanıyor… (ilk çalıştırmada birkaç dakika sürer)</div>
      </div>
    );
  }
  const t = describeTrack(r);
  const vsHold = r.equityReturnPct - r.buyHoldPct;
  return (
    <div className="box">
      <div className="box-head">
        <span>
          {title}
          <div className="faint" style={{ fontWeight: 400, fontSize: 11 }}>
            {subtitle} • {day(r.from)} → {day(r.to)} • {r.coins} coin
          </div>
        </span>
      </div>
      <table className="table num">
        <tbody>
          <tr>
            <td>İşlem (A+)</td>
            <td className="right">{r.trades}</td>
          </tr>
          <tr>
            <td>Kazanç / başa baş / kayıp / süre doldu</td>
            <td className="right">
              <span className="up">{r.wins}</span> / {r.breakevens} / <span className="down">{r.losses}</span> / {r.expired}
            </td>
          </tr>
          <tr>
            <td title="Yalnızca hedefe ulaşan işlemler">Gerçek kazanma oranı</td>
            <td className="right">{t.sufficient ? `%${r.winRatePct.toFixed(1)}` : t.text}</td>
          </tr>
          <tr>
            <td>Başa baş / kayıp oranı</td>
            <td className="right">
              {t.sufficient ? `%${r.breakevenPct.toFixed(1)} / %${r.lossPct.toFixed(1)}` : "—"}
            </td>
          </tr>
          <tr>
            <td>İşlem başına net (ücret + kayma sonrası)</td>
            <td className={`right ${r.expectancyPct >= 0 ? "up" : "down"}`}>{fmtPct(r.expectancyPct, { decimals: 3 })}</td>
          </tr>
          <tr>
            <td>Kâr faktörü</td>
            <td className={`right ${r.profitFactor >= 1 ? "up" : "down"}`}>{r.profitFactor.toFixed(2)}</td>
          </tr>
          <tr>
            <td title="Her işlemde bakiyenin %1'i riske edilerek">Equity getirisi (%1 risk/işlem)</td>
            <td className={`right ${r.equityReturnPct >= 0 ? "up" : "down"}`}>{fmtPct(r.equityReturnPct)}</td>
          </tr>
          <tr>
            <td>En büyük düşüş (max drawdown)</td>
            <td className="right down">−{r.maxDrawdownPct.toFixed(1)}%</td>
          </tr>
          <tr>
            <td>Al-tut (aynı coinler, eşit ağırlık)</td>
            <td className={`right ${r.buyHoldPct >= 0 ? "up" : "down"}`}>{fmtPct(r.buyHoldPct)}</td>
          </tr>
          <tr>
            <td>Al-tut (sadece BTC)</td>
            <td className={`right ${(r.btcBuyHoldPct ?? 0) >= 0 ? "up" : "down"}`}>{r.btcBuyHoldPct == null ? "—" : fmtPct(r.btcBuyHoldPct)}</td>
          </tr>
          <tr>
            <td>Strateji − al-tut farkı</td>
            <td className={`right ${vsHold >= 0 ? "up" : "down"}`}>{fmtPct(vsHold)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

export function BacktestSection() {
  const [data, setData] = useState<BacktestSummary | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => api.backtest().then((d) => !cancelled && setData(d)).catch(() => {});
    void load();
    const t = setInterval(load, 20_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  if (!data) return null;

  return (
    <>
      <div className="box">
        <div className="box-head">
          Geçmiş test (backtest) — strateji gerçek veride ne kadar başarılı?
          <span className="faint" style={{ fontWeight: 400, fontSize: 11 }}>
            {data.running ? "Test çalışıyor…" : data.updatedAt ? `Son güncelleme ${fmtTime(data.updatedAt)} • sürüm ${data.strategyVersion}` : "Henüz çalışmadı"}
          </span>
        </div>
        <div style={{ padding: "12px 16px", lineHeight: 1.6, fontSize: 12 }} className="muted">
          Konsensüs sinyali her coinin 1 saatlik verisinde mum mum çalıştırılır (geleceği görmeden). Her işlemden giriş + çıkış
          taker ücreti (%0.05 + %0.05) ve kayma (%0.02/taraf) düşülür; aynı mumda hem stop hem hedef/1R görülürse kötümser
          varsayım (önce stop) kullanılır; aynı coinde açık işlem varken yeni işlem açılmaz. <b>Kazanç yalnızca hedefe ulaşan
          işlemdir</b>; başa baş ve kayıp ayrı sayılır. Kurallar 2026'nın verisine bakılarak seçildi; bu yüzden asıl ölçüt{" "}
          <b>örneklem dışı</b> dönemdir.
        </div>
      </div>

      <div className="two-col">
        <PeriodCard title="Örneklem dışı (walk-forward)" subtitle="Kuralların hiç görmediği dönem" r={data.outOfSample} />
        <PeriodCard title="Son ~60 gün (örneklem içi)" subtitle="Kuralların seçildiği döneme yakın — iyimser olabilir" r={data.inSample} />
      </div>

      {data.bands.length > 0 && (
        <div className="box">
          <div className="box-head">Örneklem dışı: sinyal kalitesine göre</div>
          <table className="table num">
            <thead>
              <tr>
                <th>Tür</th>
                <th className="right">İşlem</th>
                <th>Kazanç / başa baş / kayıp</th>
                <th className="right">Net / işlem</th>
                <th className="right">Kâr faktörü</th>
              </tr>
            </thead>
            <tbody>
              {data.bands.map((b) => (
                <tr key={b.label}>
                  <td>
                    <span className={`quality ${b.label === "A+" ? "aplus" : "a"}`}>{b.label}</span>{" "}
                    <span className="faint">{b.label === "A+" ? "akıllı giriş" : "hemen giriş"}</span>
                    {b.missed ? <span className="faint"> • {b.missed} emir dolmadı</span> : null}
                  </td>
                  <td className="right">{b.trades}</td>
                  <td>{describeTrack(b).text}</td>
                  <td className={`right ${b.expectancyPct >= 0 ? "up" : "down"}`}>{fmtPct(b.expectancyPct, { decimals: 3 })}</td>
                  <td className="right">{b.profitFactor.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="box">
        <div className="box-head">Örneklem dışı: coin bazında</div>
        <div style={{ maxHeight: 420, overflow: "auto" }}>
          <table className="table num">
            <thead>
              <tr>
                <th>Coin</th>
                <th className="right">İşlem</th>
                <th>Kazanç / başa baş / kayıp</th>
                <th className="right">Net / işlem</th>
                <th className="right">Kâr faktörü</th>
              </tr>
            </thead>
            <tbody>
              {data.results.map((r) => {
                const t = describeTrack(r);
                return (
                  <tr key={`${r.symbol}${r.interval}`}>
                    <td style={{ fontWeight: 600, color: "var(--text-strong)" }}>{baseAsset(r.symbol)}</td>
                    <td className="right">{r.trades}</td>
                    <td className={t.sufficient ? "" : "faint"}>{t.text}</td>
                    <td className={`right ${t.sufficient ? (r.expectancyPct >= 0 ? "up" : "down") : "faint"}`}>
                      {t.sufficient ? fmtPct(r.expectancyPct, { decimals: 3 }) : "—"}
                    </td>
                    <td className="right">{t.sufficient ? r.profitFactor.toFixed(2) : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
