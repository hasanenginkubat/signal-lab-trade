"use client";

import { useEffect, useState } from "react";
import type { LiveOutcome, LiveReport } from "@signal-lab/shared";
import { LiveChart } from "@/components/LiveChart";
import { api } from "@/lib/api";
import { baseAsset, fmtPct, fmtPrice } from "@/lib/format";

const OUTCOME: Record<LiveOutcome, { label: string; cls: string }> = {
  TP: { label: "Hedef ✓", cls: "up" },
  BE: { label: "Başa baş", cls: "" },
  SL: { label: "Stop ✗", cls: "down" },
  EXPIRED: { label: "Süre doldu", cls: "faint" },
};

const dt = (t: number) => new Date(t).toLocaleString("tr-TR", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
const day = (t: number) => new Date(t).toLocaleDateString("tr-TR", { day: "2-digit", month: "short", year: "numeric" });
const cls = (v: number) => (v >= 0 ? "up" : "down");
const dd = (v: number) => (v > 0.005 ? `−${v.toFixed(2)}%` : "0.00%");

// ---------- CSV (Türkçe Excel uyumlu: ; ayraç, virgüllü ondalık, UTF-8 BOM) ----------
const num = (v: number, d = 4) => (Number.isFinite(v) ? v.toFixed(d).replace(".", ",") : "");
const iso = (t: number) => new Date(t).toISOString();
const row = (cells: (string | number)[]) => cells.map((c) => (typeof c === "string" && /[;"\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(";");

function toCsv(r: LiveReport): string {
  const lines: string[] = [];
  lines.push(row(["# Signal Lab canlı karne", `izleme başlangıcı ${iso(r.trackingStart)}`, `kalite ${r.quality}`, `risk %${r.riskPct}/işlem`, "maliyet %0,14 dahil"]));
  lines.push("");
  lines.push(row(["# Kâğıt işlemler"]));
  lines.push(row(["sinyal_id", "sembol", "kalite", "yön", "giriş_zamanı", "giriş_fiyatı", "çıkış_zamanı", "çıkış_fiyatı", "stop", "tp", "sonuç", "net_%", "bakiye_etkisi_%", "bakiye_sonrası"]));
  for (const t of [...r.trades].sort((a, b) => a.exitTime - b.exitTime)) {
    lines.push(row([t.id, t.symbol, t.quality ?? "", t.side, iso(t.entryTime), num(t.entryPrice, 8), iso(t.exitTime), num(t.exitPrice, 8), num(t.stopLoss, 8), num(t.takeProfit, 8), t.outcome, num(t.netPct), num(t.balanceEffectPct), num(t.balanceAfter)]));
  }
  lines.push("");
  lines.push(row(["# Haftalık tablo (Binance haftası, Pazartesi 00:00 UTC = TR 03:00)"]));
  lines.push(row(["hafta_başı", "işlem", "tp", "be", "sl", "süre_doldu", "bot_%", "btc_%", "sepet_%", "fark_bot_eksi_btc"]));
  for (const w of r.weeks) {
    lines.push(row([iso(w.weekStart), w.trades, w.wins, w.breakevens, w.losses, w.expired, num(w.botPct), num(w.btcPct), num(w.basketPct), num(w.diffPct)]));
  }
  return "﻿" + lines.join("\r\n");
}

function downloadCsv(r: LiveReport): void {
  const blob = new Blob([toCsv(r)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `canli-karne-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export default function LivePage() {
  const [r, setR] = useState<LiveReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      api
        .live()
        .then((d) => {
          if (cancelled) return;
          setR(d);
          setError(null);
        })
        .catch((e: Error) => !cancelled && setError(e.message));
    void load();
    const t = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  const s = r?.summary;
  const notStarted = r ? Date.now() < r.trackingStart : false;

  return (
    <main className="page">
      <div className="page-head">
        <h1>Canlı karne</h1>
        {r && (
          <button className="btn sm" onClick={() => downloadCsv(r)} title="Tüm kâğıt işlemler + haftalık tablo">
            CSV indir
          </button>
        )}
      </div>
      <div className="box" style={{ padding: "12px 16px", lineHeight: 1.6, fontSize: 12 }}>
        <b>Amaç botun piyasadan daha az kaybedip kaybetmediğini görmek. Değerlendirme en az 8 hafta ve 30 işlemden sonra yapılmalı.</b>
        <div className="muted" style={{ marginTop: 6 }}>
          {r ? (
            <>
              İzleme başlangıcı <b>{dt(r.trackingStart)}</b>. Bu andan sonra oluşan her <b>{r.quality}</b> sinyal, backtest ile
              aynı kurallarla (akıllı giriş, 1R'de stop girişe, 48 saat süre sınırı, %0.14 ücret + kayma) kâğıt işlem olarak
              sayılır; her işlemde bakiyenin %{r.riskPct}'i riske edilir. BTC al-tut: başlangıç bakiyesinin tamamı BTC'de.
              Sepet al-tut: başlangıçta taranan {r.basket.length} coine eşit ağırlık (liste sabit). Al-tut değerleri saatlik
              kapanışlardan; bot eğrisi kapanan işlemlerle güncellenir.
            </>
          ) : (
            "Yükleniyor…"
          )}
        </div>
      </div>
      {error && <div className="box empty">{error}</div>}
      {notStarted && <div className="box empty">İzleme henüz başlamadı.</div>}

      {r && s && (
        <>
          <div className="box">
            <div className="box-head">
              Özet
              <span className="faint" style={{ fontWeight: 400, fontSize: 11 }}>
                {s.days.toFixed(1)} gün • {r.open} açık işlem • {r.missed} akıllı giriş dolmadı
              </span>
            </div>
            {!s.sufficient && (
              <div className="guard block" style={{ margin: "10px 16px" }}>
                <b>⚠️ Yetersiz veri — sonuç yorumlanamaz</b>
                <span>
                  {s.trades} kapanmış işlem var; değerlendirme için en az 30 işlem ve 8 hafta gerekiyor. Aşağıdaki rakamlar şimdilik
                  yalnızca bilgi amaçlı.
                </span>
              </div>
            )}
            <table className="table num">
              <thead>
                <tr>
                  <th />
                  <th className="right">Bot</th>
                  <th className="right">BTC al-tut</th>
                  <th className="right">Sepet al-tut</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Toplam getiri</td>
                  <td className={`right ${cls(s.botReturnPct)}`}>{fmtPct(s.botReturnPct)}</td>
                  <td className={`right ${cls(s.btcReturnPct)}`}>{fmtPct(s.btcReturnPct)}</td>
                  <td className={`right ${cls(s.basketReturnPct)}`}>{fmtPct(s.basketReturnPct)}</td>
                </tr>
                <tr>
                  <td>En büyük düşüş (maxDD)</td>
                  <td className={`right ${s.botMaxDdPct > 0.005 ? "down" : ""}`}>{dd(s.botMaxDdPct)}</td>
                  <td className={`right ${s.btcMaxDdPct > 0.005 ? "down" : ""}`}>{dd(s.btcMaxDdPct)}</td>
                  <td className={`right ${s.basketMaxDdPct > 0.005 ? "down" : ""}`}>{dd(s.basketMaxDdPct)}</td>
                </tr>
              </tbody>
            </table>
            <table className="table num">
              <tbody>
                <tr>
                  <td>İşlem sayısı (günlük ort.)</td>
                  <td className="right">
                    {s.trades} ({s.perDay.toFixed(2)}/gün)
                  </td>
                </tr>
                <tr>
                  <td>Hedef / başa baş / stop / süre doldu</td>
                  <td className="right">
                    <span className="up">{s.wins}</span> / {s.breakevens} / <span className="down">{s.losses}</span> / {s.expired}
                  </td>
                </tr>
                <tr>
                  <td title="Yalnızca hedefe ulaşan işlemler">Kazanma oranı</td>
                  <td className={`right ${s.sufficient ? "" : "faint"}`}>
                    {s.trades ? `%${s.winRatePct.toFixed(1)}` : "—"}
                    {!s.sufficient && s.trades ? " (yetersiz veri)" : ""}
                  </td>
                </tr>
                <tr>
                  <td>Kâr faktörü</td>
                  <td className={`right ${s.sufficient ? (s.profitFactor >= 1 ? "up" : "down") : "faint"}`}>
                    {s.trades ? (Number.isFinite(s.profitFactor) ? s.profitFactor.toFixed(2) : "∞") : "—"}
                    {!s.sufficient && s.trades ? " (yetersiz veri)" : ""}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <div className="box">
            <div className="box-head">
              Bakiye eğrisi (başlangıç = 100)
              <span className="faint" style={{ fontWeight: 400, fontSize: 11 }}>
                <span style={{ color: "#0ecb81" }}>━ Bot</span> • <span style={{ color: "#f0b90b" }}>━ BTC al-tut</span> •{" "}
                <span style={{ color: "#5b8def" }}>┅ Sepet al-tut</span>
              </span>
            </div>
            {r.points.length > 1 ? <LiveChart points={r.points} /> : <div className="box empty">İlk saatlik kapanış bekleniyor.</div>}
          </div>

          <div className="box">
            <div className="box-head">Haftalık (Binance haftası: Pazartesi TR 03:00)</div>
            <table className="table num">
              <thead>
                <tr>
                  <th>Hafta</th>
                  <th className="right">İşlem</th>
                  <th>TP / BE / SL</th>
                  <th className="right">Bot</th>
                  <th className="right">BTC</th>
                  <th className="right">Sepet</th>
                  <th className="right">Fark (bot − BTC)</th>
                </tr>
              </thead>
              <tbody>
                {r.weeks.length === 0 && (
                  <tr>
                    <td colSpan={7} className="faint">
                      Henüz hafta yok.
                    </td>
                  </tr>
                )}
                {[...r.weeks].reverse().map((w) => (
                  <tr key={w.weekStart}>
                    <td>{day(w.weekStart)}</td>
                    <td className="right">{w.trades}</td>
                    <td>
                      <span className="up">{w.wins}</span> / {w.breakevens} / <span className="down">{w.losses}</span>
                      {w.expired ? <span className="faint"> (+{w.expired} süre)</span> : null}
                    </td>
                    <td className={`right ${cls(w.botPct)}`}>{fmtPct(w.botPct)}</td>
                    <td className={`right ${cls(w.btcPct)}`}>{fmtPct(w.btcPct)}</td>
                    <td className={`right ${cls(w.basketPct)}`}>{fmtPct(w.basketPct)}</td>
                    <td className={`right ${cls(w.diffPct)}`}>{fmtPct(w.diffPct)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="box">
            <div className="box-head">Kâğıt işlemler</div>
            <div style={{ maxHeight: 480, overflow: "auto" }}>
              <table className="table num">
                <thead>
                  <tr>
                    <th>Coin</th>
                    <th>Giriş</th>
                    <th>Çıkış</th>
                    <th className="right">Stop / TP</th>
                    <th>Sonuç</th>
                    <th className="right">Net</th>
                    <th className="right">Bakiye etkisi</th>
                    <th className="right">Bakiye</th>
                  </tr>
                </thead>
                <tbody>
                  {r.trades.length === 0 && (
                    <tr>
                      <td colSpan={8} className="faint">
                        Henüz kapanmış işlem yok.
                      </td>
                    </tr>
                  )}
                  {r.trades.map((t) => (
                    <tr key={t.id}>
                      <td style={{ fontWeight: 600, color: "var(--text-strong)" }}>
                        {baseAsset(t.symbol)} <span className="faint">{t.quality}</span>
                      </td>
                      <td>
                        {fmtPrice(t.entryPrice)} <span className="faint">{dt(t.entryTime)}</span>
                      </td>
                      <td>
                        {fmtPrice(t.exitPrice)} <span className="faint">{dt(t.exitTime)}</span>
                      </td>
                      <td className="right">
                        <span className="down">{fmtPrice(t.stopLoss)}</span> / <span className="up">{fmtPrice(t.takeProfit)}</span>
                      </td>
                      <td className={OUTCOME[t.outcome].cls}>{OUTCOME[t.outcome].label}</td>
                      <td className={`right ${cls(t.netPct)}`}>{fmtPct(t.netPct)}</td>
                      <td className={`right ${cls(t.balanceEffectPct)}`}>{fmtPct(t.balanceEffectPct)}</td>
                      <td className="right">{t.balanceAfter.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </main>
  );
}
