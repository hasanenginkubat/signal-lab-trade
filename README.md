# Signal Lab

A crypto signal terminal and backtesting engine for **Binance USDⓈ-M Futures**, written in TypeScript
(Node.js server, Next.js web app, shared package in an npm-workspaces monorepo).

It streams live futures data, draws TradingView-style charts, scores several technical conditions into a
single buy/sell **consensus**, and lets you open and close trades **manually** on a paper account (or, if you
explicitly configure it, a real Binance account). Every signal is tracked to its outcome and the same rules are
replayed by an honest, out-of-sample backtester.

> **Result up front:** the strategy was tested on four previously unseen market regimes (2021–2024) with
> success criteria fixed in advance. **It failed them and is rejected** — see [Results](#results). The project
> is published as an engineering and research-methodology example, not as a profitable trading system.

> ⚠️ **Not financial advice. Paper-trading mode is the default. Do not use this with real money.**

---

## Screenshots

> 📷 _Placeholder — Terminal (chart, signal lights, consensus panel, order panel):_ `docs/screenshots/terminal.png`
<!-- ![Terminal](docs/screenshots/terminal.png) -->

> 📷 _Placeholder — Live scorecard (bot vs BTC vs basket buy-and-hold, weekly table):_ `docs/screenshots/live-scorecard.png`
<!-- ![Live scorecard](docs/screenshots/live-scorecard.png) -->

## Features

- **Live charts** with `lightweight-charts`: 1m–1d candles, EMA 9/21/50/200, Bollinger, volume, RSI, MACD;
  historic signals drawn as green (buy) / red (exit) lights, open-signal target and stop lines.
- **Consensus engine** on every 1h close: weekly/daily/4h/1h/15m trend, day/week open, daily VWAP and three
  strategies (trend continuation, 20-bar breakout, MACD momentum) vote with weights. A signal requires a
  consensus threshold, at least one triggering strategy, ADX ≥ 18 and RSI ≤ 75. Quality tiers **A+** / **A**.
- **Trade plan**: stop = 8-bar swing low − 0.25×ATR (clamped to 1–2.5 ATR), target = 1.5R, "smart entry"
  limit 0.25 ATR below the signal close, stop moved to entry at 1R, 48h time stop.
- **Selective mode (A+ only)** on by default: notifications and trade buttons only for A+ signals.
- **Paper broker** that follows Binance rules (isolated margin, fees, liquidation, min. order size, max 5x).
- **Signal scorecard** and **live scorecard** (`/live`): paper trades vs BTC and equal-weight basket
  buy-and-hold, weekly table, CSV export.
- **Backtest page**: out-of-sample vs in-sample period cards, per-quality and per-coin breakdown.
- Risk guard for one-click trades (max open positions, daily loss stop, losing-streak pause).

## Architecture

```
signal-lab/
├── packages/shared   Types, constants, indicators (EMA, SMA, RSI, MACD, Bollinger, ATR, ADX, levels),
│                     signal gate / label helpers — used by both server and web
├── apps/server       Node.js REST + WebSocket API (port 4000)
│   ├── src/binance/     REST + WebSocket clients (auto-reconnect, stale-connection detection)
│   ├── src/market/      Candle cache and last prices
│   ├── src/signals/     strategy.ts, consensus.ts (pure, tested) + engine.ts (runs on candle closes)
│   ├── src/backtest/    Simulator, consensus backtest, out-of-sample service
│   ├── src/scorecard/   Live signal outcome tracker (same rules as the backtest)
│   ├── src/live/        Live scorecard: paper trades vs buy-and-hold
│   ├── src/trading/     Broker interface: PaperBroker and BinanceBroker, risk guard
│   ├── src/db/          Atomic JSON store + realtime hub
│   ├── src/api/         REST routes
│   └── scripts/history4 Reproducible 2021–2024 out-of-sample study
└── web               Next.js 16 / React 19 UI (port 3000)
```

```
Binance futures REST/WS ──► apps/server ──(REST + WebSocket)──► web (Next.js)
                              │  engine → tracker → live scorecard
                              └─ JSON files in apps/server/data (git-ignored)
```

Market data comes from Binance's public endpoints (`fapi.binance.com`, `wss://fstream.binance.com/market`).
No API key is needed for paper mode.

## Backtest methodology

The numbers in this README follow these rules (the same rules drive the live tracker):

| Rule | Detail |
| --- | --- |
| Costs | **0.14 % per round trip**: taker fee 0.05 % × 2 + slippage 0.02 % × 2 |
| Win definition | **Only a take-profit hit is a win.** Breakeven exits and losses are counted separately |
| Breakeven | Stop moved **exactly to entry** after 1R, so a breakeven exit is −0.14 % net |
| Same-candle ambiguity | If a candle touches both stop and target (or 1R), **the stop is assumed first** |
| Overlap | No overlapping trades on the same coin; **cooldown starts when the position closes** |
| No look-ahead | Higher-timeframe candles are only used once closed |
| Position sizing | 1 % of equity risked per trade, compounded (for return and max drawdown) |
| Out-of-sample | Rules were chosen on 2026 data; evaluation uses periods the rules never saw |
| Pre-registered criteria | Success criteria were written down **before** looking at the results |
| Small samples | Fewer than 30 trades is shown as "insufficient data" instead of a win rate |

## Results

### Out-of-sample study, 2021–2024 (universe A, fixed 20 majors)

Universe A: BTC, ETH, BNB, SOL, XRP, ADA, DOGE, LINK, LTC, DOT, AVAX, BCH, TRX, XLM, ETC, ATOM, FIL, UNI,
AAVE, NEAR (all had futures data at the start of every period). Buy-and-hold basket = equal weight, fixed at
period start. Full table incl. universe B and all columns: [docs/backtest-2021-2024.csv](docs/backtest-2021-2024.csv).

| Period | Set | Trades | PF | Return (1 % risk) | Max DD | BTC hold | Basket hold |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Bull 2021-01-01 → 2021-11-10 | A+ | 580 | 0.87 | −40.9 % | 58.7 % | +131.5 % | +1628.4 % |
| | All | 1622 | 1.08 | +58.5 % | 50.1 % | | |
| Bear 2021-11-10 → 2022-12-31 | A+ | 67 | 0.53 | −19.3 % | 25.8 % | −75.3 % | −80.0 % |
| | All | 587 | 0.65 | −76.8 % | 77.4 % | | |
| Range/recovery 2023 | A+ | 400 | 0.71 | −50.5 % | 50.5 % | +155.9 % | +141.7 % |
| | All | 1283 | 0.87 | −67.1 % | 76.2 % | | |
| ETF rally 2024 | A+ | 448 | 0.79 | −41.2 % | 46.7 % | +121.1 % | +78.3 % |
| | All | 1345 | 0.90 | −57.4 % | 70.2 % | | |
| **All four periods** | A+ | 1495 | 0.80 | −86.1 % | 89.3 % | +223.2 % | +1392.8 % |
| | All | 4837 | 0.94 | −94.9 % | 98.3 % | | |

**Pre-registered criteria (universe A, A+):**

- ✅ PASS — Bear: bot loss smaller than half the basket loss (−19.3 % vs −40.0 %) and bot max DD below basket max DD (25.8 % vs 80.9 %). This is mostly because very few signals fired, not because of an edge.
- ❌ FAIL — All periods combined: PF ≥ 1.0 and ≥ 200 trades (PF 0.80, 1495 trades).
- ❌ FAIL — Bull and ETF periods: positive return (−40.9 % and −41.2 %).

**Verdict: the strategy is rejected.** The A+ win rate was 19–25 %, far below the ~40 % a 1.5R target needs
after costs, and it lost money in every regime while simply holding BTC returned +223 %.

### Earlier measurement fix (before/after, 48 coins, 1h, A+)

| | Last 60 days (Aug–Oct 2026, uptrend) | Out-of-sample (Jul 2025 – Jan 2026, downtrend) |
| --- | --- | --- |
| Buy-and-hold (equal-weight coins / BTC) | +105 % / +28.7 % | −26.1 % / −26.5 % |
| Old logic, **old measurement** (what the UI showed) | 245 trades, "hit rate" 65.3 %, PF 2.01, 48 overlapping trades | 279 trades, "hit rate" 48.4 %, 55 overlapping trades |
| Old logic, **correct measurement** | 262 trades, **TP win rate 35.9 %**, PF 1.65, max DD 9.8 % | 280 trades, **TP win rate 28.9 %**, PF 0.97, max DD 37.6 % |
| Experimental stricter gate (reverted) | 19 trades, win 15.8 %, PF 0.31 | 63 trades, win 19.0 %, PF 0.56 |

A single regime-filter hypothesis (no new longs while BTC daily close < EMA200 or EMA50 < EMA200) was also
tested: out-of-sample PF moved from 0.95 to 1.01 (all signals) and stayed at 1.04 (A+), below the pre-set
1.1 bar, so it was **not** added.

## Lessons learned

1. **Measurement errors inflate results more than any indicator tweak.** The original "hit rate" counted every
   trade with a positive result, including breakeven exits that closed at +0.15R, used lower fees for limit
   entries, and allowed overlapping trades on the same coin. The screen showed ~65 %; the real take-profit rate
   was ~36 %, and ~29 % out of sample. A system that "feels like 80 % accuracy" can be a coin flip after costs.
2. **Overfitting is easy and invisible in-sample.** Rules picked on a strong 2026 uptrend looked excellent on
   that same data (PF 1.6+) and failed on every unseen period. Only out-of-sample tests with criteria fixed
   in advance gave an honest answer.
3. **Survivorship bias.** Universe B (today's auto-selected top coins, restricted to those that existed back
   then) is biased toward coins that survived and grew; its buy-and-hold basket returned +2541 % vs +1393 %
   for the fixed majors over the four periods. Decisions were made on the fixed universe A.
4. **Compare against buy-and-hold.** A strategy can show a positive PF in a bull market and still massively
   underperform simply holding BTC.
5. **Small samples lie.** Win rates on n < 30 are hidden behind "insufficient data".

## Getting started

Requirements: Node.js 22+ (developed and tested with Node 26), npm.

```bash
git clone <repo-url> signal-lab
cd signal-lab
npm install
cp .env.example .env      # optional; defaults work (paper mode)
npm run dev               # server: http://localhost:4000, web: http://localhost:3000
```

| Command | Description |
| --- | --- |
| `npm run dev` | Server + web in development mode |
| `npm run build && npm start` | Production build and start |
| `npm test` | Unit tests (indicators, strategy, consensus, backtest, paper broker, live scorecard) |
| `npm run typecheck` | TypeScript check for server and web |
| `docker compose up` | Run both services with Docker |

Reproduce the 2021–2024 study (downloads thousands of kline pages from Binance; roughly 40 minutes):

```bash
cd apps/server
export DIR=/tmp/hist4 && mkdir -p $DIR
npx tsx scripts/history4/universe.ts         # today's auto universe (B)
npx tsx scripts/history4/dl4.ts run          # 1d/4h/1h/15m data, cached on disk
for p in bull21 bear22 flat23 etf24; do npx tsx scripts/history4/ev4.ts $p; done
npx tsx scripts/history4/rep4.ts             # table, criteria, CSV text in $DIR/report.json
```

### Trading modes

- **Paper (default, `TRADING_MODE=paper`)**: no real money; 100 USDT starting balance; isolated margin,
  fees, liquidation, SL/TP, limit orders, partial closes and Binance minimum order sizes are simulated. State is
  stored in `apps/server/data/` (git-ignored).
- **Binance (`TRADING_MODE=binance`)**: orders go to your real futures account. **Not tested with real keys.**
  If you experiment anyway, use the testnet (`BINANCE_TRADE_REST=https://demo-fapi.binance.com`), a key with
  futures permission only, **withdrawals disabled** and an IP whitelist. Never commit `.env`.

Main configuration lives in [.env.example](.env.example) and `apps/server/src/config.ts`.

## Disclaimer

This software is provided for educational and research purposes only. It is **not financial advice**. The
strategy in this repository failed its out-of-sample tests. Trading leveraged derivatives can lose more than
your deposit. **Do not use it with real money.** The authors accept no liability for any losses.

## License

[MIT](LICENSE) © Hasan Engin Kubat

---

## Türkçe özet

**Signal Lab**, Binance USDⓈ-M Futures verisiyle çalışan bir kripto sinyal terminali ve backtest motorudur
(TypeScript; Node.js sunucu, Next.js arayüz, ortak paket — npm workspaces monorepo). Canlı grafik, çok koşullu
konsensüs sinyali, kâğıt hesapta manuel işlem, sinyal karnesi ve "canlı karne" (bot vs BTC ve sepet al-tut) içerir.

**Sonuç:** Strateji, sonuçlar görülmeden önce sabitlenen ölçütlerle 2021–2024 arasındaki dört farklı piyasa
döneminde test edildi ve **ölçütleri geçemedi; reddedildi**. A+ sinyallerin dört dönem birleşik kâr faktörü 0.80,
%1 riskle getirisi −%86; aynı sürede BTC al-tut +%223. Ölçüm kuralları: işlem başına %0.14 maliyet, yalnızca
hedef (TP) kazanç sayılır, başa baş stop tam girişte, aynı mumda önce stop, aynı coinde çakışan işlem yok.

**Çıkarılan dersler:** Eski ekranda ~%65 görünen "isabet", doğru ölçümle %36 (örneklem dışı %29) çıktı; kurallar
seçildiği dönemde çok iyi görünüp görmediği her dönemde başarısız oldu (overfitting); bugünkü coin listesiyle
geriye test hayatta kalan yanılgısı taşır.

**Uyarı:** Kâğıt hesap modu varsayılandır. Bu bir finansal tavsiye değildir. **Gerçek parayla kullanmayın.**
# signal-lab-trade
