"use client";

import { fmtPct, fmtUsd, pnlClass } from "@/lib/format";
import { useStore } from "@/lib/store";

export function AccountPanel() {
  const summary = useStore((s) => s.account?.summary);
  if (!summary) return <div className="panel account muted">Hesap yükleniyor…</div>;

  const ratio = summary.marginRatioPct;
  const ratioColor = ratio < 30 ? "var(--up-strong)" : ratio < 70 ? "var(--warn)" : "var(--down-strong)";
  const usedPct = summary.equity > 0 ? ((summary.usedMargin + summary.orderMargin) / summary.equity) * 100 : 0;

  return (
    <div className="panel account">
      <div>
        <div className="muted" style={{ fontSize: 11 }}>
          Marjin bakiyesi (varlık)
        </div>
        <div className="equity-big num">
          {fmtUsd(summary.equity)} <span className="faint" style={{ fontSize: 12 }}>USDT</span>
        </div>
        <div className={`num ${pnlClass(summary.returnPct)}`} style={{ fontSize: 12 }}>
          {fmtPct(summary.returnPct)} başlangıçtan beri ({fmtUsd(summary.initialBalance)} USDT)
        </div>
      </div>

      <div className="kv num">
        <div>
          <span className="k">Cüzdan bakiyesi</span>
          <span className="v">{fmtUsd(summary.walletBalance)}</span>
        </div>
        <div>
          <span className="k">Kullanılabilir</span>
          <span className="v">{fmtUsd(summary.availableBalance)}</span>
        </div>
        <div>
          <span className="k">Gerçekleşmemiş K/Z</span>
          <span className={`v ${pnlClass(summary.unrealizedPnl)}`}>{fmtUsd(summary.unrealizedPnl, { sign: true })}</span>
        </div>
        <div>
          <span className="k">Kullanılan marjin</span>
          <span className="v">{fmtUsd(summary.usedMargin)}</span>
        </div>
        <div>
          <span className="k">Bugünkü K/Z</span>
          <span className={`v ${pnlClass(summary.realizedPnlToday)}`}>
            {fmtUsd(summary.realizedPnlToday, { sign: true })}
          </span>
        </div>
        <div>
          <span className="k">Toplam gerçekleşen</span>
          <span className={`v ${pnlClass(summary.realizedPnlTotal)}`}>
            {fmtUsd(summary.realizedPnlTotal, { sign: true })}
          </span>
        </div>
        <div>
          <span className="k">Emir marjini</span>
          <span className="v">{fmtUsd(summary.orderMargin)}</span>
        </div>
        <div>
          <span className="k">Bakım marjini</span>
          <span className="v">{fmtUsd(summary.maintenanceMargin)}</span>
        </div>
      </div>

      <div className="field">
        <div className="label">
          <span>Marjin oranı</span>
          <span className="num" style={{ color: ratioColor }}>
            {ratio.toFixed(2)}%
          </span>
        </div>
        <div className="meter" title="Bakım marjı / marjin bakiyesi. %100'e ulaşırsa likidasyon olur.">
          <div style={{ width: `${Math.min(100, ratio)}%`, background: ratioColor }} />
        </div>
      </div>
      <div className="field">
        <div className="label">
          <span>Bakiye kullanımı</span>
          <span className="num">{usedPct.toFixed(1)}%</span>
        </div>
        <div className="meter">
          <div style={{ width: `${Math.min(100, usedPct)}%`, background: "var(--accent)" }} />
        </div>
      </div>
      <div className="kv num">
        <div>
          <span className="k">Kazanma oranı</span>
          <span className="v">
            {summary.tradeCount ? `${summary.winRatePct.toFixed(1)}%` : "—"}{" "}
            <span className="faint" style={{ fontSize: 11 }}>
              ({summary.tradeCount} işlem)
            </span>
          </span>
        </div>
        <div>
          <span className="k">Ödenen ücret</span>
          <span className="v">{fmtUsd(summary.feesTotal)}</span>
        </div>
      </div>
    </div>
  );
}
