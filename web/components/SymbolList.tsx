"use client";

import { useMemo, useState } from "react";
import type { SymbolBias } from "@signal-lab/shared";
import { baseAsset, fmtCompact, fmtPct, fmtPrice } from "@/lib/format";
import { useStore } from "@/lib/store";
import { ActiveSignals } from "./ActiveSignals";
import { ConsensusBadge } from "./SignalAction";

type SortKey = "opportunity" | "change" | "volume";

export function BiasBadge({ bias }: { bias: SymbolBias | undefined }) {
  if (!bias) return <span className="bias neutral">—</span>;
  const s = bias.score;
  const cls = s >= 3 ? "long" : s <= -3 ? "short" : "neutral";
  const label = s >= 3 ? "AL" : s <= -3 ? "SAT" : "NÖTR";
  return (
    <span
      className={`bias ${cls}`}
      title={`${bias.interval} skor: ${s.toFixed(1)} • Trend: ${bias.trend} • RSI: ${bias.rsi?.toFixed(1) ?? "—"}`}
    >
      {label} <span className="num">{s > 0 ? "+" : ""}{s.toFixed(1)}</span>
    </span>
  );
}

export function SymbolList({ selected, onSelect }: { selected: string; onSelect: (symbol: string) => void }) {
  const symbols = useStore((s) => s.symbols);
  const tickers = useStore((s) => s.tickers);
  const biases = useStore((s) => s.biases);
  const primary = useStore((s) => s.primaryInterval);
  const openSignals = useStore((s) => s.signals);
  const opportunities = useStore((s) => s.opportunities);
  const consensus = useStore((s) => s.consensus);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("opportunity");

  const opp = useMemo(() => new Map(opportunities.map((o) => [o.symbol, o])), [opportunities]);

  const withOpenSignal = useMemo(() => {
    const m = new Map<string, "LONG" | "SHORT">();
    for (const s of openSignals) if (s.status === "OPEN" && !m.has(s.symbol)) m.set(s.symbol, s.side);
    return m;
  }, [openSignals]);

  const rows = useMemo(() => {
    const q = query.trim().toUpperCase();
    const list = symbols.filter((s) => !q || s.includes(q));
    if (sort === "opportunity") list.sort((a, b) => (opp.get(b)?.score ?? 0) - (opp.get(a)?.score ?? 0));
    if (sort === "change") list.sort((a, b) => (tickers[b]?.changePct ?? 0) - (tickers[a]?.changePct ?? 0));
    if (sort === "volume") list.sort((a, b) => (tickers[b]?.quoteVolume ?? 0) - (tickers[a]?.quoteVolume ?? 0));
    return list;
  }, [symbols, tickers, query, sort, opp]);

  return (
    <div className="panel area-watch">
      <ActiveSignals onSelect={onSelect} selected={selected} />
      <div className="panel-header" style={{ flexDirection: "column", alignItems: "stretch" }}>
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <span>Gün içi coinler</span>
          <span
            className="faint"
            style={{ fontWeight: 400, fontSize: 11, cursor: "help" }}
            title={
              "Liste Binance Futures'ta en çok işlem gören ve gün içinde yeterince hareket eden kripto coinlerden otomatik seçilir (hisse/emtia kontratları ve pompa coinler hariç).\n\n" +
              "Fırsat skoru = hacim (kolay al-sat) + hareketlilik (kâr potansiyeli) + trend gücü + stratejinin o coindeki geçmiş başarısı.\n\n" +
              "BTC'nin hacmi en yüksektir (günde ~15+ milyar $) ama günlük hareketi %1-3 ile düşüktür; daha hareketli coinler daha çok fırsat ama daha çok risk demektir."
            }
          >
            Nasıl seçildi? ⓘ
          </span>
        </div>
        <input
          className="search"
          placeholder="Coin ara…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Coin ara"
        />
      </div>
      <div className="watch-head">
        <button className={sort === "opportunity" ? "active" : ""} onClick={() => setSort("opportunity")}>
          Coin / Fırsat
        </button>
        <button
          className={sort === "volume" ? "active" : ""}
          style={{ textAlign: "right" }}
          onClick={() => setSort(sort === "volume" ? "opportunity" : "volume")}
        >
          Fiyat / Hacim
        </button>
        <button
          className={sort === "change" ? "active" : ""}
          style={{ textAlign: "right" }}
          onClick={() => setSort(sort === "change" ? "opportunity" : "change")}
        >
          24s %
        </button>
      </div>
      <div className="panel-body">
        {rows.map((symbol) => {
          const t = tickers[symbol];
          const bias = biases[`${symbol}:${primary}`];
          const sig = withOpenSignal.get(symbol);
          return (
            <div
              key={symbol}
              className={`watch-row ${symbol === selected ? "active" : ""}`}
              onClick={() => onSelect(symbol)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => e.key === "Enter" && onSelect(symbol)}
            >
              <div className="watch-sym">
                <span className="name">
                  {baseAsset(symbol)}
                  <small>/USDT</small>
                  {sig && (
                    <span
                      title={`Açık ${sig === "LONG" ? "AL" : "SAT"} sinyali`}
                      style={{ marginLeft: 6, color: sig === "LONG" ? "var(--up-strong)" : "var(--down-strong)" }}
                    >
                      {sig === "LONG" ? "▲" : "▼"}
                    </span>
                  )}
                </span>
                <span style={{ display: "flex", gap: 4, alignItems: "center" }}>
                  {consensus[symbol] ? <ConsensusBadge view={consensus[symbol]} /> : <BiasBadge bias={bias} />}
                  {opp.get(symbol) && (
                    <span
                      className={`opp ${opp.get(symbol)!.score >= 55 ? "hi" : "mid"}`}
                      title={`Gün içi fırsat skoru ${opp.get(symbol)!.score}/100\n${opp.get(symbol)!.reason}`}
                    >
                      {opp.get(symbol)!.score}
                    </span>
                  )}
                </span>
              </div>
              <span className="watch-price num">
                {fmtPrice(t?.price)}
                <small>{t ? `${fmtCompact(t.quoteVolume)} $` : ""}</small>
              </span>
              <span className={`watch-change num ${t ? (t.changePct >= 0 ? "up" : "down") : ""}`}>
                {fmtPct(t?.changePct)}
              </span>
            </div>
          );
        })}
        {rows.length === 0 && <div className="empty">{symbols.length ? "Eşleşen coin yok" : "Yükleniyor…"}</div>}
      </div>
    </div>
  );
}
