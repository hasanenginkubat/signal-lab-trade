"use client";

import type { PendingOrder } from "@signal-lab/shared";
import { api } from "@/lib/api";
import { baseAsset, fmtPrice, fmtTime, fmtUsd } from "@/lib/format";
import { notify, refreshAccount, useStore } from "@/lib/store";

const NO_ORDERS: PendingOrder[] = [];

export function OrdersTable({ onSelectSymbol }: { onSelectSymbol: (s: string) => void }) {
  const orders = useStore((s) => s.account?.orders ?? NO_ORDERS);
  const tickers = useStore((s) => s.tickers);

  if (orders.length === 0) return <div className="empty">Bekleyen limit emir yok.</div>;

  async function cancel(id: string) {
    try {
      await api.cancelOrder(id);
      await refreshAccount();
    } catch (err) {
      notify("error", (err as Error).message);
    }
  }

  return (
    <table className="table num">
      <thead>
        <tr>
          <th>Zaman</th>
          <th>Sembol</th>
          <th className="right">Limit fiyatı</th>
          <th className="right">Güncel</th>
          <th className="right">Mesafe</th>
          <th className="right">Teminat</th>
          <th>SL / TP</th>
          <th className="right" />
        </tr>
      </thead>
      <tbody>
        {orders.map((o) => {
          const px = tickers[o.symbol]?.price;
          return (
            <tr key={o.id}>
              <td className="faint">{fmtTime(o.createdAt)}</td>
              <td>
                <span className="sym-link" onClick={() => onSelectSymbol(o.symbol)}>
                  {baseAsset(o.symbol)}
                </span>{" "}
                <span className={`side-tag ${o.side === "LONG" ? "long" : "short"}`}>
                  {o.side} {o.leverage}x
                </span>
              </td>
              <td className="right">{fmtPrice(o.price)}</td>
              <td className="right">{fmtPrice(px)}</td>
              <td className="right faint">{px ? `${(((o.price - px) / px) * 100).toFixed(2)}%` : "—"}</td>
              <td className="right">{fmtUsd(o.margin)}</td>
              <td>
                <span className="down">{o.stopLoss ? fmtPrice(o.stopLoss) : "—"}</span> /{" "}
                <span className="up">{o.takeProfit ? fmtPrice(o.takeProfit) : "—"}</span>
              </td>
              <td className="right">
                <button className="btn sm danger-ghost" onClick={() => cancel(o.id)}>
                  İptal
                </button>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
