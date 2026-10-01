"use client";

import { MIN_TRADES_FOR_STATS, type ScorecardRow } from "@signal-lab/shared";
import { baseAsset, fmtPct } from "@/lib/format";

export function ScorecardTable({ title, rows, symbolKeys }: { title: string; rows: ScorecardRow[]; symbolKeys?: boolean }) {
  return (
    <div className="box">
      <div className="box-head">{title}</div>
      {rows.length === 0 ? (
        <div className="empty">Veri yok.</div>
      ) : (
        <table className="table num">
          <thead>
            <tr>
              <th />
              <th className="right">Toplam</th>
              <th className="right">Açık</th>
              <th className="right" title="Hedefe ulaşan">Kazanç</th>
              <th className="right" title="Stop girişe çekilip orada kapanan">Başa baş</th>
              <th className="right" title="Stop olan">Kayıp</th>
              <th className="right" title="Akıllı giriş dolmadı">Kaçırıldı</th>
              <th className="right" title="Kazanç / kapanan (n ≥ 30 ise)">Kazanma oranı</th>
              <th className="right">Ort. sonuç</th>
              <th className="right">Toplam sonuç</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                <td style={{ fontWeight: 600, color: "var(--text-strong)" }}>
                  {symbolKeys ? baseAsset(r.key) : r.key === "LONG" ? "AL (Long)" : r.key === "SHORT" ? "SAT (Short)" : r.key}
                </td>
                <td className="right">{r.total}</td>
                <td className="right faint">{r.open}</td>
                <td className="right up">{r.wins}</td>
                <td className="right">{r.breakevens}</td>
                <td className="right down">{r.losses}</td>
                <td className="right faint">{r.missed}</td>
                <td className="right">
                  {(() => {
                    const closed = r.total - r.open - r.missed;
                    if (!closed) return "—";
                    if (closed < MIN_TRADES_FOR_STATS) return <span className="faint">yetersiz veri (n={closed})</span>;
                    return <span>{r.winRatePct.toFixed(1)}%</span>;
                  })()}
                </td>
                <td className={`right ${r.avgResultPct >= 0 ? "up" : "down"}`}>{fmtPct(r.avgResultPct)}</td>
                <td className={`right ${r.totalResultPct >= 0 ? "up" : "down"}`}>{fmtPct(r.totalResultPct)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
