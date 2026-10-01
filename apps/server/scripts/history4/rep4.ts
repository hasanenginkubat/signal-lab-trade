/** 4 dönem raporu: tablo (markdown + CSV) ve önceden sabitlenmiş kriterler. */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { equityCurve, stats } from "../../src/backtest/backtest";

const DIR = process.env.DIR!;
const KEYS = [["bull21", "Boğa 2021-01-01→2021-11-10"], ["bear22", "Ayı 2021-11-10→2022-12-31"], ["flat23", "Yatay 2023"], ["etf24", "ETF 2024"]] as const;
const A = ["BTC", "ETH", "BNB", "SOL", "XRP", "ADA", "DOGE", "LINK", "LTC", "DOT", "AVAX", "BCH", "TRX", "XLM", "ETC", "ATOM", "FIL", "UNI", "AAVE", "NEAR"].map((s) => s + "USDT");
const B: string[] = JSON.parse(readFileSync(join(DIR, "universeB.json"), "utf8"));
const DAY = 86_400_000;
const maxDd = (v: number[]) => { let p = -Infinity, d = 0; for (const x of v) { p = Math.max(p, x); d = Math.max(d, (p - x) / p * 100); } return d; };

type Row = Record<string, any>;
const rows: Row[] = [];
const comb: Record<string, { trades: any[]; days: number; btc: number; basketSeries: number[]; basketMul: number }> = {};
const excluded: Record<string, { A: string[]; B: string[]; nA: number; nB: number }> = {};
for (const [key, label] of KEYS) {
  const r = JSON.parse(readFileSync(join(DIR, `res_${key}.json`), "utf8"));
  const days = (r.to - r.from) / DAY;
  excluded[key] = { A: r.excludedA, B: r.excludedB, nA: A.filter((s) => r.symbols.includes(s)).length, nB: B.filter((s) => r.symbols.includes(s)).length };
  const btcH = r.hold["BTCUSDT"];
  const btc = (btcH.closes.at(-1)[1] / btcH.start - 1) * 100;
  for (const [uni, list] of [["A", A], ["B", B]] as const) {
    const syms = list.filter((s: string) => r.symbols.includes(s));
    // Sepet: dönem başında eşit ağırlık, dengelemesiz; saatlik değer
    const maps = syms.map((s: string) => ({ start: r.hold[s].start, m: new Map<number, number>(r.hold[s].closes) }));
    const last = maps.map((x: any) => x.start);
    const series: number[] = [100];
    for (const [t] of btcH.closes) {
      maps.forEach((x: any, k: number) => { const c = x.m.get(t); if (c != null) last[k] = c; });
      series.push((100 * maps.reduce((a: number, x: any, k: number) => a + last[k] / x.start, 0)) / maps.length);
    }
    const basket = series.at(-1)! - 100;
    for (const set of ["aplus", "all"] as const) {
      const tr = syms.flatMap((s: string) => r.trades[s][set]);
      const st = stats(tr);
      const eq = equityCurve(tr, 1);
      const ck = `${uni}:${set}`;
      comb[ck] ??= { trades: [], days: 0, btc: 1, basketSeries: [100], basketMul: 1 };
      const c = comb[ck];
      c.trades.push(...tr); c.days += days;
      if (set === "aplus") { /* aynı dönem değerleri iki sette ortak; bir kez zincirle */ }
      rows.push({ period: label, key, uni, set: set === "aplus" ? "A+" : "Tümü", coins: syms.length, n: st.trades, perDay: st.trades / days, tp: st.wins, be: st.breakevens, sl: st.losses, exp: st.expired, net: st.expectancyPct, pf: st.profitFactor, win: st.winRatePct, dd: eq.maxDrawdownPct, ret: eq.returnPct, btc, basket, basketDd: maxDd(series), series });
    }
  }
}
// Birleşik satırlar
for (const uni of ["A", "B"]) for (const set of ["aplus", "all"]) {
  const c = comb[`${uni}:${set}`];
  const per = rows.filter((x) => x.uni === uni && x.set === (set === "aplus" ? "A+" : "Tümü"));
  let mul = 1; const chained: number[] = [];
  for (const p of per) { for (const v of p.series) chained.push(mul * v); mul *= p.series.at(-1) / 100; }
  const st = stats(c.trades); const eq = equityCurve(c.trades, 1);
  rows.push({ period: "Dört dönem birleşik", key: "all", uni, set: set === "aplus" ? "A+" : "Tümü", coins: null, n: st.trades, perDay: st.trades / c.days, tp: st.wins, be: st.breakevens, sl: st.losses, exp: st.expired, net: st.expectancyPct, pf: st.profitFactor, win: st.winRatePct, dd: eq.maxDrawdownPct, ret: eq.returnPct,
    btc: (per.reduce((a, p) => a * (1 + p.btc / 100), 1) - 1) * 100, basket: (mul - 1) * 100, basketDd: maxDd(chained) });
}
const order = (x: Row) => ["bull21", "bear22", "flat23", "etf24", "all"].indexOf(x.key) * 10 + (x.uni === "A" ? 0 : 5) + (x.set === "A+" ? 0 : 1);
rows.sort((a, b) => order(a) - order(b));
const f = (v: number, d = 2) => (v >= 0 ? "+" : "−") + Math.abs(v).toFixed(d);
const md = ["| Dönem | Evren | Set | İşlem | Gün/ort. | TP / BE / SL / süre | Ort. net % | PF | Kazanma % | maxDD % | Getiri % | BTC al-tut % | Sepet al-tut % | Sepet maxDD % |", "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|"];
for (const x of rows) md.push(`| ${x.period} | ${x.uni}${x.coins != null ? ` (${x.coins})` : ""} | ${x.set} | ${x.n} | ${x.perDay.toFixed(2)} | ${x.tp} / ${x.be} / ${x.sl} / ${x.exp} | ${f(x.net, 3)} | ${x.pf.toFixed(2)} | ${x.win.toFixed(1)} | ${x.dd.toFixed(1)} | ${f(x.ret, 1)} | ${f(x.btc, 1)} | ${f(x.basket, 1)} | ${x.basketDd.toFixed(1)} |`);
const csv = ["donem;evren;set;coin;islem;gunluk_ort;tp;be;sl;sure_doldu;ort_net_pct;pf;kazanma_pct;maxdd_pct;getiri_pct;btc_altut_pct;sepet_altut_pct;sepet_maxdd_pct"];
for (const x of rows) csv.push([x.period, x.uni, x.set, x.coins ?? "", x.n, x.perDay.toFixed(3), x.tp, x.be, x.sl, x.exp, x.net.toFixed(4), x.pf.toFixed(4), x.win.toFixed(2), x.dd.toFixed(2), x.ret.toFixed(2), x.btc.toFixed(2), x.basket.toFixed(2), x.basketDd.toFixed(2)].join(";"));
// Kriterler (A evreni, A+)
const g = (k: string) => rows.find((x) => x.key === k && x.uni === "A" && x.set === "A+")!;
const bear = g("bear22"), all = g("all"), bull = g("bull21"), etf = g("etf24");
const c1a = bear.basket < 0 ? bear.ret > bear.basket / 2 : bear.ret >= 0;
const c1b = bear.dd < bear.basketDd;
const crit = [
  [`Ayı: bot kaybı < sepet kaybının yarısı (bot ${f(bear.ret, 1)}% vs sepet/2 ${f(bear.basket / 2, 1)}%) VE bot maxDD < sepet maxDD (${bear.dd.toFixed(1)}% vs ${bear.basketDd.toFixed(1)}%)`, c1a && c1b],
  [`Birleşik: PF ≥ 1.0 (${all.pf.toFixed(2)}) VE işlem ≥ 200 (${all.n})`, all.pf >= 1 && all.n >= 200],
  [`Boğa ve ETF: bot getirisi > 0 (boğa ${f(bull.ret, 1)}%, ETF ${f(etf.ret, 1)}%)`, bull.ret > 0 && etf.ret > 0],
] as const;
const out = { md: md.join("\n"), csv: csv.join("\n"), crit: crit.map(([t, ok]) => `- ${ok ? "GEÇTİ" : "KALDI"} — ${t}`).join("\n"), excluded, c1a, c1b };
writeFileSync(join(DIR, "report.json"), JSON.stringify(out, null, 1));
console.log(out.md); console.log(out.crit); console.log(JSON.stringify(excluded));
