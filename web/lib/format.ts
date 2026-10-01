/** Fiyat büyüklüğüne göre ondalık basamak seçer (BTC 2, küçük coinler 4-6). */
export function priceDecimals(price: number): number {
  const p = Math.abs(price);
  if (p >= 1000) return 2;
  if (p >= 10) return 3;
  if (p >= 1) return 4;
  if (p >= 0.01) return 5;
  return 7;
}

export function fmtPrice(price: number | null | undefined, decimals?: number): string {
  if (price == null || !Number.isFinite(price)) return "—";
  const d = decimals ?? priceDecimals(price);
  return price.toLocaleString("tr-TR", { minimumFractionDigits: d, maximumFractionDigits: d });
}

export function fmtUsd(v: number | null | undefined, opts: { sign?: boolean; decimals?: number } = {}): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const d = opts.decimals ?? 2;
  const s = Math.abs(v).toLocaleString("tr-TR", { minimumFractionDigits: d, maximumFractionDigits: d });
  const sign = v < 0 ? "−" : opts.sign && v > 0 ? "+" : "";
  return `${sign}${s}`;
}

export function fmtPct(v: number | null | undefined, opts: { sign?: boolean; decimals?: number } = {}): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const d = opts.decimals ?? 2;
  const sign = v < 0 ? "−" : opts.sign !== false && v > 0 ? "+" : "";
  return `${sign}${Math.abs(v).toFixed(d)}%`;
}

export function fmtQty(v: number): string {
  if (!Number.isFinite(v)) return "—";
  const d = v >= 100 ? 1 : v >= 1 ? 3 : 5;
  return v.toLocaleString("tr-TR", { maximumFractionDigits: d });
}

export function fmtCompact(v: number): string {
  return new Intl.NumberFormat("tr-TR", { notation: "compact", maximumFractionDigits: 2 }).format(v);
}

export function fmtTime(ts: number, withDate = true): string {
  const d = new Date(ts);
  const time = d.toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" });
  if (!withDate) return time;
  return `${d.toLocaleDateString("tr-TR", { day: "2-digit", month: "2-digit" })} ${time}`;
}

export function fmtDuration(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}dk`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}s ${m % 60}dk`;
  return `${Math.floor(h / 24)}g ${h % 24}s`;
}

export function pnlClass(v: number | null | undefined): string {
  if (v == null || v === 0 || !Number.isFinite(v)) return "";
  return v > 0 ? "up" : "down";
}

export function baseAsset(symbol: string): string {
  return symbol.replace(/USDT$/, "");
}
