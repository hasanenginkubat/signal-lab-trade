"use client";

import { useEffect, useState } from "react";
import type { Position } from "@signal-lab/shared";
import { api } from "@/lib/api";
import { baseAsset, fmtPct, fmtPrice, fmtUsd, pnlClass } from "@/lib/format";
import { notify, refreshAccount, setQuickPanel, useStore } from "@/lib/store";

const NO_POSITIONS: Position[] = [];

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName);
}

/** Klavye kısayolları: Q = hızlı panel, Shift+X = tümünü kapat (onaylı), Esc = kapat */
export function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      const open = document.body.dataset.quickPanel === "1";
      if (e.key === "Escape" && open) setQuickPanel(false);
      else if (e.key.toLowerCase() === "q" && !e.shiftKey) setQuickPanel(!open);
      else if (e.key.toLowerCase() === "x" && e.shiftKey) setQuickPanel(true, true);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

export function QuickPanelButton() {
  const positions = useStore((s) => s.account?.positions ?? NO_POSITIONS);
  const open = useStore((s) => s.quickPanel);
  const pnl = positions.reduce((a, p) => a + p.unrealizedPnl, 0);
  return (
    <button className="quick-btn" onClick={() => setQuickPanel(!open)} title="Hızlı panel (Q)">
      <span>Pozisyonlar {positions.length}</span>
      {positions.length > 0 && <span className={`num ${pnlClass(pnl)}`}>{fmtUsd(pnl, { sign: true })}</span>}
      <span className="kbd">Q</span>
    </button>
  );
}

export function QuickPanel() {
  const open = useStore((s) => s.quickPanel);
  const confirmAll = useStore((s) => s.quickConfirm);
  const summary = useStore((s) => s.account?.summary);
  const positions = useStore((s) => s.account?.positions ?? NO_POSITIONS);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    document.body.dataset.quickPanel = open ? "1" : "0";
    if (!open) setConfirming(false);
  }, [open]);
  useEffect(() => {
    if (confirmAll) setConfirming(true);
  }, [confirmAll]);

  if (!open) return null;
  const totalPnl = positions.reduce((a, p) => a + p.unrealizedPnl, 0);

  async function closeOne(p: Position) {
    setBusy(p.id);
    try {
      await api.closePosition(p.id, 100);
      await refreshAccount();
    } catch (err) {
      notify("error", (err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function closeAll() {
    setBusy("all");
    try {
      const r = await api.closeAll();
      notify(
        r.errors.length ? "error" : "success",
        r.errors.length
          ? `Bazı pozisyonlar kapatılamadı: ${r.errors.join("; ")}`
          : `${r.closed} pozisyon kapatıldı • ${fmtUsd(r.realizedPnl, { sign: true })} USDT`,
      );
      await refreshAccount();
      setConfirming(false);
    } catch (err) {
      notify("error", (err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <div className="backdrop" onClick={() => setQuickPanel(false)} />
      <div className="quick-panel" role="dialog" aria-label="Hızlı panel">
        <div className="quick-section">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <span className="muted" style={{ fontSize: 11 }}>
              Toplam varlık
            </span>
            <button className="btn sm ghost" onClick={() => setQuickPanel(false)}>
              Kapat <span className="kbd">Esc</span>
            </button>
          </div>
          <div className="equity-big num">{fmtUsd(summary?.equity)} USDT</div>
          <div className="kv num" style={{ marginTop: 8 }}>
            <div>
              <span className="k">Kullanılabilir</span>
              <span className="v">{fmtUsd(summary?.availableBalance)}</span>
            </div>
            <div>
              <span className="k">Açık K/Z</span>
              <span className={`v ${pnlClass(summary?.unrealizedPnl)}`}>{fmtUsd(summary?.unrealizedPnl, { sign: true })}</span>
            </div>
            <div>
              <span className="k">Kullanılan marjin</span>
              <span className="v">{fmtUsd(summary?.usedMargin)}</span>
            </div>
            <div>
              <span className="k">Bugünkü K/Z</span>
              <span className={`v ${pnlClass(summary?.realizedPnlToday)}`}>
                {fmtUsd(summary?.realizedPnlToday, { sign: true })}
              </span>
            </div>
          </div>
        </div>

        <div className="quick-section">
          <div className="analysis-title" style={{ marginTop: 0 }}>
            Açık pozisyonlar ({positions.length})
          </div>
          {positions.length === 0 && <div className="faint" style={{ padding: "8px 0" }}>Açık pozisyon yok.</div>}
          {positions.map((p) => (
            <div key={p.id} className="quick-pos num">
              <div>
                <b style={{ color: "var(--text-strong)" }}>{baseAsset(p.symbol)}</b>{" "}
                <span className={`side-tag ${p.side === "LONG" ? "long" : "short"}`}>
                  {p.side} {p.leverage}x
                </span>
                <div className="faint" style={{ fontSize: 10 }}>
                  Giriş {fmtPrice(p.entryPrice)} → {fmtPrice(p.markPrice)}
                  {p.takeProfit ? <span className="up"> • SAT {fmtPrice(p.takeProfit)}</span> : null}
                </div>
              </div>
              <div className={pnlClass(p.unrealizedPnl)} style={{ textAlign: "right" }}>
                {fmtUsd(p.unrealizedPnl, { sign: true })}
                <div style={{ fontSize: 10 }}>{fmtPct(p.roePct)}</div>
              </div>
              <button className="btn sm danger-ghost" disabled={busy !== null} onClick={() => closeOne(p)}>
                {busy === p.id ? "…" : "Kapat"}
              </button>
            </div>
          ))}
        </div>

        {positions.length > 0 && (
          <div className="quick-section">
            {confirming ? (
              <div className="confirm-box">
                <span>
                  {positions.length} pozisyonun tamamı piyasa fiyatından kapatılacak. Tahmini sonuç:{" "}
                  <b className={pnlClass(totalPnl)}>{fmtUsd(totalPnl, { sign: true })} USDT</b>
                </span>
                <div className="btn-row">
                  <button className="btn close-all" disabled={busy !== null} onClick={closeAll} autoFocus>
                    {busy === "all" ? "Kapatılıyor…" : "Evet, hepsini kapat"}
                  </button>
                  <button className="btn" onClick={() => setConfirming(false)}>
                    Vazgeç
                  </button>
                </div>
              </div>
            ) : (
              <button className="btn close-all" onClick={() => setConfirming(true)}>
                Tümünü kapat ({positions.length}) <span className="kbd" style={{ color: "white" }}>⇧X</span>
              </button>
            )}
          </div>
        )}

        <div className="quick-section faint" style={{ fontSize: 11, borderBottom: "none" }}>
          Kısayollar: <span className="kbd">Q</span> hızlı panel · <span className="kbd">⇧X</span> tümünü kapat ·{" "}
          <span className="kbd">Esc</span> kapat
        </div>
      </div>
    </>
  );
}
