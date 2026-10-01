"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { fmtPct, fmtUsd, pnlClass } from "@/lib/format";
import { useStore } from "@/lib/store";
import { ConnectionStatus } from "./ConnectionStatus";
import { QuickPanelButton } from "./QuickPanel";

const LINKS = [
  { href: "/", label: "Terminal" },
  { href: "/portfolio", label: "Portföy" },
  { href: "/report", label: "Günlük Rapor" },
  { href: "/scorecard", label: "Sinyal Karnesi" },
  { href: "/live", label: "Canlı Karne" },
];

export function TopBar() {
  const pathname = usePathname();
  const mode = useStore((s) => s.mode);
  const summary = useStore((s) => s.account?.summary);
  const isTerminal = !LINKS.slice(1).some((l) => pathname.startsWith(l.href));

  return (
    <header className="topbar">
      <Link href="/" className="brand">
        <span className="brand-mark">SL</span>
        Signal Lab
      </Link>
      <nav className="nav">
        {LINKS.map((l) => (
          <Link
            key={l.href}
            href={l.href}
            className={(l.href === "/" ? isTerminal : pathname.startsWith(l.href)) ? "active" : ""}
          >
            {l.label}
          </Link>
        ))}
      </nav>
      {mode && (
        <span
          className={`mode-badge ${mode}`}
          title={mode === "paper" ? "Simülasyon hesabı — gerçek para kullanılmaz" : "Gerçek Binance Futures hesabı"}
        >
          {mode === "paper" ? "Kâğıt hesap" : "Gerçek hesap"}
        </span>
      )}
      <div className="topbar-spacer" />
      {summary && (
        <div className="topbar-equity">
          <div className="stat-inline">
            <span className="label">Varlık</span>
            <span className="value num">{fmtUsd(summary.equity)} USDT</span>
          </div>
          <div className="stat-inline">
            <span className="label">Açık K/Z</span>
            <span className={`value num ${pnlClass(summary.unrealizedPnl)}`}>
              {fmtUsd(summary.unrealizedPnl, { sign: true })}
            </span>
          </div>
          <div className="stat-inline">
            <span className="label">Bugün</span>
            <span className={`value num ${pnlClass(summary.realizedPnlToday)}`}>
              {fmtUsd(summary.realizedPnlToday, { sign: true })}
            </span>
          </div>
          <div className="stat-inline">
            <span className="label">Toplam getiri</span>
            <span className={`value num ${pnlClass(summary.returnPct)}`}>{fmtPct(summary.returnPct)}</span>
          </div>
        </div>
      )}
      <QuickPanelButton />
      <ConnectionStatus />
    </header>
  );
}
