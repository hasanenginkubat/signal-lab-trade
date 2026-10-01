"use client";

import { useEffect, useMemo, useState } from "react";
import type { EquityPoint } from "@signal-lab/shared";
import { EquityChart } from "@/components/EquityChart";
import { TradeHistory, useTrades } from "@/components/TradeHistory";
import { api } from "@/lib/api";
import { baseAsset, fmtPct, fmtUsd, pnlClass } from "@/lib/format";
import { notify, setAccount, useStore } from "@/lib/store";

export default function PortfolioPage() {
  const summary = useStore((s) => s.account?.summary);
  const mode = useStore((s) => s.mode);
  const version = useStore((s) => s.tradesVersion);
  const trades = useTrades(5000);
  const [equity, setEquity] = useState<EquityPoint[]>([]);

  useEffect(() => {
    api.equity().then(setEquity).catch(() => {});
  }, [version]);

  const stats = useMemo(() => {
    if (!trades || trades.length === 0) return null;
    // Kısmi kapatmaları pozisyon bazında birleştir
    const byPos = new Map<string, number>();
    for (const t of trades) {
      // Binance geçmişinde pozisyon kimliği yok; her satır ayrı sayılır
      const key = mode === "binance" ? t.id : t.positionId;
      byPos.set(key, (byPos.get(key) ?? 0) + t.realizedPnl);
    }
    const results = [...byPos.values()];
    const wins = results.filter((r) => r > 0);
    const losses = results.filter((r) => r <= 0);
    const grossWin = wins.reduce((a, b) => a + b, 0);
    const grossLoss = -losses.reduce((a, b) => a + b, 0);

    const bySymbol = new Map<string, { pnl: number; count: number; wins: number }>();
    for (const t of trades) {
      const row = bySymbol.get(t.symbol) ?? { pnl: 0, count: 0, wins: 0 };
      row.pnl += t.realizedPnl;
      row.count += 1;
      if (t.realizedPnl > 0) row.wins += 1;
      bySymbol.set(t.symbol, row);
    }
    return {
      count: results.length,
      winRate: (wins.length / results.length) * 100,
      avgWin: wins.length ? grossWin / wins.length : 0,
      avgLoss: losses.length ? -grossLoss / losses.length : 0,
      profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
      best: Math.max(...results),
      worst: Math.min(...results),
      bySymbol: [...bySymbol.entries()].sort((a, b) => b[1].pnl - a[1].pnl),
    };
  }, [trades, mode]);

  const maxDrawdown = useMemo(() => {
    let peak = -Infinity;
    let maxDd = 0;
    for (const p of equity) {
      peak = Math.max(peak, p.equity);
      if (peak > 0) maxDd = Math.max(maxDd, ((peak - p.equity) / peak) * 100);
    }
    return maxDd;
  }, [equity]);

  async function reset() {
    const input = window.prompt("Kâğıt hesap sıfırlansın mı? Tüm pozisyonlar ve geçmiş silinir.\nBaşlangıç bakiyesi (USDT):", "100");
    if (input == null) return;
    const balance = Number(input);
    if (!(balance > 0)) return notify("error", "Geçerli bir bakiye girin");
    try {
      setAccount(await api.resetAccount(balance));
      setEquity(await api.equity());
    } catch (err) {
      notify("error", (err as Error).message);
    }
  }

  const maxAbs = stats ? Math.max(...stats.bySymbol.map(([, r]) => Math.abs(r.pnl)), 1) : 1;

  return (
    <main className="page">
      <div className="page-head">
        <h1>Portföy ve performans</h1>
        {mode === "paper" && (
          <button className="btn danger-ghost" onClick={reset}>
            Kâğıt hesabı sıfırla
          </button>
        )}
      </div>

      <div className="cards num">
        <div className="card">
          <span className="k">Toplam varlık</span>
          <span className="v">{fmtUsd(summary?.equity)}</span>
          <span className={`sub ${pnlClass(summary?.returnPct)}`}>{fmtPct(summary?.returnPct)} toplam getiri</span>
        </div>
        <div className="card">
          <span className="k">Gerçekleşen K/Z</span>
          <span className={`v ${pnlClass(summary?.realizedPnlTotal)}`}>{fmtUsd(summary?.realizedPnlTotal, { sign: true })}</span>
          <span className={`sub ${pnlClass(summary?.realizedPnlToday)}`}>
            Bugün {fmtUsd(summary?.realizedPnlToday, { sign: true })}
          </span>
        </div>
        <div className="card">
          <span className="k">Açık K/Z</span>
          <span className={`v ${pnlClass(summary?.unrealizedPnl)}`}>{fmtUsd(summary?.unrealizedPnl, { sign: true })}</span>
          <span className="sub muted">Marjin: {fmtUsd(summary?.usedMargin)} USDT</span>
        </div>
        <div className="card">
          <span className="k">Kazanma oranı</span>
          <span className="v">{stats ? `${stats.winRate.toFixed(1)}%` : "—"}</span>
          <span className="sub muted">{stats?.count ?? 0} işlem</span>
        </div>
        <div className="card">
          <span className="k">Kâr faktörü</span>
          <span className="v">
            {stats ? (Number.isFinite(stats.profitFactor) ? stats.profitFactor.toFixed(2) : "∞") : "—"}
          </span>
          <span className="sub muted">Toplam kazanç / toplam kayıp</span>
        </div>
        <div className="card">
          <span className="k">Maks. düşüş (drawdown)</span>
          <span className="v down">{equity.length ? `−${maxDrawdown.toFixed(2)}%` : "—"}</span>
          <span className="sub muted">Varlık zirvesinden</span>
        </div>
        {stats && mode === "paper" && (
          <>
            <div className="card">
              <span className="k">Ort. kazanç / kayıp</span>
              <span className="v">
                <span className="up">{fmtUsd(stats.avgWin)}</span> / <span className="down">{fmtUsd(stats.avgLoss)}</span>
              </span>
            </div>
            <div className="card">
              <span className="k">En iyi / en kötü işlem</span>
              <span className="v">
                <span className="up">{fmtUsd(stats.best, { sign: true })}</span> /{" "}
                <span className="down">{fmtUsd(stats.worst, { sign: true })}</span>
              </span>
            </div>
            <div className="card">
              <span className="k">Ödenen ücret</span>
              <span className="v">{fmtUsd(summary?.feesTotal)}</span>
            </div>
          </>
        )}
      </div>

      <div className="box">
        <div className="box-head">
          Varlık eğrisi
          <span className="faint" style={{ fontWeight: 400, fontSize: 11 }}>
            5 dakikada bir ve her işlem kapanışında kaydedilir
          </span>
        </div>
        {equity.length > 1 ? (
          <EquityChart points={equity} baseline={summary?.initialBalance ?? equity[0].equity} />
        ) : (
          <div className="empty">Eğri için henüz yeterli veri yok.</div>
        )}
      </div>

      <div className="box">
        <div className="box-head">Coin bazında K/Z</div>
        {stats ? (
          <table className="table num">
            <thead>
              <tr>
                <th>Sembol</th>
                <th className="right">İşlem</th>
                <th className="right">Kazanma</th>
                <th>Net K/Z</th>
              </tr>
            </thead>
            <tbody>
              {stats.bySymbol.map(([symbol, r]) => (
                <tr key={symbol}>
                  <td>{baseAsset(symbol)}</td>
                  <td className="right">{r.count}</td>
                  <td className="right">{((r.wins / r.count) * 100).toFixed(0)}%</td>
                  <td>
                    <div className="bar-cell">
                      <div
                        className="bar"
                        style={{
                          width: `${(Math.abs(r.pnl) / maxAbs) * 160}px`,
                          background: r.pnl >= 0 ? "var(--up)" : "var(--down)",
                        }}
                      />
                      <span className={pnlClass(r.pnl)}>{fmtUsd(r.pnl, { sign: true })}</span>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="empty">Henüz kapanmış işlem yok.</div>
        )}
      </div>

      <div className="box">
        <div className="box-head">İşlem geçmişi</div>
        <div style={{ maxHeight: 520, overflow: "auto" }}>
          <TradeHistory limit={1000} />
        </div>
      </div>
    </main>
  );
}
