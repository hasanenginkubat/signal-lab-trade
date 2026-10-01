"use client";

import { useState } from "react";
import type { Position } from "@signal-lab/shared";
import { api } from "@/lib/api";
import { baseAsset, fmtDuration, fmtPct, fmtPrice, fmtQty, fmtUsd, pnlClass } from "@/lib/format";
import { notify, refreshAccount, setQuickPanel, useStore } from "@/lib/store";

const NO_POSITIONS: Position[] = [];

export function PositionsTable({ onSelectSymbol }: { onSelectSymbol: (s: string) => void }) {
  const positions = useStore((s) => s.account?.positions ?? NO_POSITIONS);
  const mode = useStore((s) => s.mode);
  const [editing, setEditing] = useState<string | null>(null);

  if (positions.length === 0) return <div className="empty">Açık pozisyon yok. Sağdaki panelden işlem açabilirsiniz.</div>;

  async function close(p: Position, percent: number) {
    if (mode === "binance" && !window.confirm(`${p.symbol} pozisyonunun %${percent}'i piyasa fiyatından kapatılsın mı?`)) return;
    try {
      await api.closePosition(p.id, percent);
      await refreshAccount();
    } catch (err) {
      notify("error", (err as Error).message);
    }
  }

  const total = positions.reduce((a, p) => a + p.unrealizedPnl, 0);

  return (
    <table className="table num">
      <thead>
        <tr>
          <th colSpan={11} style={{ background: "var(--panel-2)" }}>
            <span style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <span>
                Toplam açık K/Z: <b className={pnlClass(total)}>{fmtUsd(total, { sign: true })} USDT</b>
              </span>
              <button className="btn sm danger-ghost" style={{ marginLeft: "auto" }} onClick={() => setQuickPanel(true, true)}>
                Tümünü kapat <span className="kbd">⇧X</span>
              </button>
            </span>
          </th>
        </tr>
        <tr>
          <th>Sembol</th>
          <th className="right">Büyüklük</th>
          <th className="right">Giriş</th>
          <th className="right">Güncel</th>
          <th className="right">Likidasyon</th>
          <th className="right">Teminat</th>
          <th className="right">K/Z (ROE)</th>
          <th title="Satış otomatik: hedef ya da stop emri">Satış planı</th>
          <th>SL / TP</th>
          <th>Süre</th>
          <th className="right">Kapat</th>
        </tr>
      </thead>
      <tbody>
        {positions.map((p) => (
          <tr key={p.id}>
            <td>
              <span className="sym-link" onClick={() => onSelectSymbol(p.symbol)}>
                {baseAsset(p.symbol)}
              </span>{" "}
              <span className={`side-tag ${p.side === "LONG" ? "long" : "short"}`}>
                {p.side} {p.leverage}x
              </span>
            </td>
            <td className="right">
              {fmtQty(p.quantity)}
              <div className="faint" style={{ fontSize: 10 }}>
                {fmtUsd(p.notional)} USDT
              </div>
            </td>
            <td className="right">{fmtPrice(p.entryPrice)}</td>
            <td className="right">{fmtPrice(p.markPrice)}</td>
            <td className="right warn">{p.liquidationPrice > 0 ? fmtPrice(p.liquidationPrice) : "—"}</td>
            <td className="right">{fmtUsd(p.margin)}</td>
            <td className={`right ${pnlClass(p.unrealizedPnl)}`}>
              {fmtUsd(p.unrealizedPnl, { sign: true })}
              <div style={{ fontSize: 10 }}>{fmtPct(p.roePct)}</div>
            </td>
            <td>
              {p.takeProfit ? (
                <div className="up" title="Bu fiyata gelince hedef emri otomatik satar">
                  SAT {fmtPrice(p.takeProfit)}{" "}
                  <span style={{ fontSize: 10 }}>
                    ({fmtUsd(((p.takeProfit - p.entryPrice) * p.quantity * (p.side === "LONG" ? 1 : -1)), { sign: true })})
                  </span>
                </div>
              ) : (
                <div className="faint">Hedef yok — elle sat</div>
              )}
              {p.stopLoss && (
                <div className="faint" style={{ fontSize: 10 }}>
                  stop {fmtPrice(p.stopLoss)} ({fmtUsd(((p.stopLoss - p.entryPrice) * p.quantity * (p.side === "LONG" ? 1 : -1)), { sign: true })})
                </div>
              )}
            </td>
            <td>
              {editing === p.id ? (
                <ProtectionEditor position={p} onDone={() => setEditing(null)} />
              ) : (
                <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <span className={p.stopLoss && (p.side === "LONG" ? p.stopLoss >= p.entryPrice : p.stopLoss <= p.entryPrice) ? "up" : "down"}>
                    {p.stopLoss ? fmtPrice(p.stopLoss) : "—"}
                  </span>
                  {p.stopLoss && (p.side === "LONG" ? p.stopLoss >= p.entryPrice : p.stopLoss <= p.entryPrice) ? (
                    <span className="status-pill tp" title="Stop girişte: en kötü ihtimalle ücret + kayma kadar eksiyle kapanır">
                      Stop girişte
                    </span>
                  ) : p.breakevenAtR ? (
                    <span className="status-pill" title={`Fiyat ${p.breakevenAtR}R kâra geçince stop girişe taşınacak`}>
                      Oto BE
                    </span>
                  ) : null}
                  /
                  <span className="up">{p.takeProfit ? fmtPrice(p.takeProfit) : "—"}</span>
                  <button className="btn sm ghost" onClick={() => setEditing(p.id)}>
                    Düzenle
                  </button>
                </span>
              )}
            </td>
            <td className="faint">
              {fmtDuration(Date.now() - p.openedAt)}
              {p.closeAt && (
                <div style={{ fontSize: 10 }} title="Bu süre sonunda hâlâ açıksa piyasa fiyatından kapatılır (testle aynı kural)">
                  zaman stopu: {fmtDuration(Math.max(0, p.closeAt - Date.now()))}
                </div>
              )}
            </td>
            <td className="right">
              <span className="btn-row" style={{ justifyContent: "flex-end" }}>
                <button className="btn sm ghost" onClick={() => close(p, 25)}>
                  %25
                </button>
                <button className="btn sm ghost" onClick={() => close(p, 50)}>
                  %50
                </button>
                <button className="btn sm danger-ghost" onClick={() => close(p, 100)}>
                  Kapat
                </button>
              </span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ProtectionEditor({ position, onDone }: { position: Position; onDone: () => void }) {
  const [sl, setSl] = useState(position.stopLoss?.toString() ?? "");
  const [tp, setTp] = useState(position.takeProfit?.toString() ?? "");
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      await api.updateProtection(position.id, {
        stopLoss: sl ? Number(sl) : null,
        takeProfit: tp ? Number(tp) : null,
      });
      notify("success", `${position.symbol} SL/TP güncellendi`);
      await refreshAccount();
      onDone();
    } catch (err) {
      notify("error", (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <span style={{ display: "flex", gap: 4, alignItems: "center" }}>
      <input className="input-sm" placeholder="SL" value={sl} onChange={(e) => setSl(e.target.value)} aria-label="Stop loss" />
      <input className="input-sm" placeholder="TP" value={tp} onChange={(e) => setTp(e.target.value)} aria-label="Take profit" />
      <button className="btn sm primary" disabled={busy} onClick={save}>
        Kaydet
      </button>
      <button className="btn sm ghost" onClick={onDone}>
        Vazgeç
      </button>
    </span>
  );
}
