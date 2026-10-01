"use client";

import { useEffect, useState } from "react";
import type { CloseReason, Trade } from "@signal-lab/shared";
import { api } from "@/lib/api";
import { baseAsset, fmtDuration, fmtPct, fmtPrice, fmtQty, fmtTime, fmtUsd, pnlClass } from "@/lib/format";
import { useStore } from "@/lib/store";

export const REASON_LABEL: Record<CloseReason, string> = {
  MANUAL: "Manuel",
  STOP_LOSS: "Stop loss",
  TAKE_PROFIT: "Take profit",
  LIQUIDATION: "Likidasyon",
  TIME_STOP: "Süre doldu (48s)",
};

export function useTrades(limit = 200): Trade[] | null {
  const version = useStore((s) => s.tradesVersion);
  const socketState = useStore((s) => s.socket);
  const [trades, setTrades] = useState<Trade[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    api
      .trades(limit)
      .then((t) => !cancelled && setTrades(t))
      .catch(() => !cancelled && setTrades((prev) => prev ?? []));
    return () => {
      cancelled = true;
    };
  }, [version, limit, socketState]);
  return trades;
}

export function TradeHistory({ onSelectSymbol, limit = 200 }: { onSelectSymbol?: (s: string) => void; limit?: number }) {
  const trades = useTrades(limit);
  const mode = useStore((s) => s.mode);

  if (!trades) return <div className="empty">Yükleniyor…</div>;
  if (trades.length === 0) return <div className="empty">Henüz kapanmış işlem yok.</div>;

  if (mode === "binance") {
    return (
      <table className="table num">
        <thead>
          <tr>
            <th>Zaman</th>
            <th>Sembol</th>
            <th className="right">Gerçekleşen K/Z</th>
          </tr>
        </thead>
        <tbody>
          {trades.map((t) => (
            <tr key={t.id}>
              <td className="faint">{fmtTime(t.closedAt)}</td>
              <td>{baseAsset(t.symbol)}</td>
              <td className={`right ${pnlClass(t.realizedPnl)}`}>{fmtUsd(t.realizedPnl, { sign: true })}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  return (
    <table className="table num">
      <thead>
        <tr>
          <th>Kapanış</th>
          <th>Sembol</th>
          <th className="right">Miktar</th>
          <th className="right">Giriş</th>
          <th className="right">Çıkış</th>
          <th className="right">Net K/Z</th>
          <th className="right">ROE</th>
          <th className="right">Ücret</th>
          <th>Neden</th>
          <th>Süre</th>
        </tr>
      </thead>
      <tbody>
        {trades.map((t) => (
          <tr key={t.id}>
            <td className="faint">{fmtTime(t.closedAt)}</td>
            <td>
              <span className="sym-link" onClick={() => onSelectSymbol?.(t.symbol)}>
                {baseAsset(t.symbol)}
              </span>{" "}
              <span className={`side-tag ${t.side === "LONG" ? "long" : "short"}`}>
                {t.side} {t.leverage}x
              </span>
              {t.signalId && (
                <span className="faint" title="Sinyalden açıldı" style={{ marginLeft: 4 }}>
                  ⚡
                </span>
              )}
            </td>
            <td className="right">{fmtQty(t.quantity)}</td>
            <td className="right">{fmtPrice(t.entryPrice)}</td>
            <td className="right">{fmtPrice(t.exitPrice)}</td>
            <td className={`right ${pnlClass(t.realizedPnl)}`}>{fmtUsd(t.realizedPnl, { sign: true })}</td>
            <td className={`right ${pnlClass(t.roePct)}`}>{fmtPct(t.roePct)}</td>
            <td className="right faint">{fmtUsd(t.fees)}</td>
            <td className={t.reason === "LIQUIDATION" ? "down" : t.reason === "TAKE_PROFIT" ? "up" : ""}>
              {REASON_LABEL[t.reason]}
            </td>
            <td className="faint">{fmtDuration(t.closedAt - t.openedAt)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
