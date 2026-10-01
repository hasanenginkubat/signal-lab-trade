import { EventEmitter } from "node:events";
import { adx, atr, describeTrack, type Opportunity } from "@signal-lab/shared";
import type { BacktestService } from "../backtest/service";
import type { MarketData } from "../market/marketData";
import { trendOf } from "../signals/strategy";

const REFRESH_MS = 60_000;

export interface OpportunityEvents {
  updated: [Opportunity[]];
}

/**
 * Gün içi trade uygunluğunu puanlar. İyi bir gün içi coin:
 *  - likittir (yüksek hacim → kolay giriş/çıkış, düşük kayma),
 *  - yeterince hareket eder (15dk mumda %0.3-1.5; çok sakin = fırsat yok, çok sert = risk),
 *  - net bir trendi vardır (1s ADX), ve
 *  - stratejimiz o coinde geçmişte kazandırmıştır (backtest).
 */
export class OpportunityScanner extends EventEmitter<OpportunityEvents> {
  private list: Opportunity[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly market: MarketData,
    private readonly backtests: BacktestService,
  ) {
    super();
  }

  start(): void {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), REFRESH_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  get(): Opportunity[] {
    return this.list;
  }

  async refresh(): Promise<void> {
    const out: Opportunity[] = [];
    for (const t of this.market.getTickers()) {
      try {
        const m15 = await this.market.getClosedCandles(t.symbol, "15m", 100);
        const h1 = await this.market.getClosedCandles(t.symbol, "1h", 300);
        const a = atr(m15, 14);
        const atrPct = (a[a.length - 1] / t.price) * 100;
        const adxValues = adx(h1, 14).adx;
        const adxNow = adxValues[adxValues.length - 1];
        const trend = trendOf(h1);
        const rangePct = t.low > 0 ? ((t.high - t.low) / t.low) * 100 : 0;

        const volScore = Math.min(1, Math.max(0, (Math.log10(t.quoteVolume) - 8) / 2)); // 100M→0, 10B→1
        const moveScore =
          atrPct < 0.15 ? 0.1 : atrPct < 0.3 ? 0.5 : atrPct <= 1.5 ? 1 : atrPct <= 3 ? 0.5 : 0.1;
        const trendScore = Number.isFinite(adxNow) ? Math.min(1, Math.max(0, (adxNow - 15) / 20)) : 0;
        const rec = this.backtests.record(t.symbol, "1h") ?? this.backtests.record(t.symbol, "15m");
        // Coin karnesi yalnızca yeterli veri varsa (n ≥ 30) skora katılır
        const edgeScore = rec?.sufficient ? Math.min(1, Math.max(0, 0.5 + rec.expectancyPct)) : 0.5;
        const score = Math.round((volScore * 0.3 + moveScore * 0.3 + trendScore * 0.2 + edgeScore * 0.2) * 100);

        const reasons: string[] = [];
        reasons.push(
          t.quoteVolume >= 1e9
            ? "Çok yüksek hacim (kolay al-sat)"
            : t.quoteVolume >= 3e8
              ? "İyi hacim"
              : "Hacim orta",
        );
        reasons.push(
          atrPct < 0.3
            ? "çok sakin, kâr potansiyeli düşük"
            : atrPct > 1.5
              ? "çok sert hareketler, risk yüksek"
              : `günlük aralık %${rangePct.toFixed(1)}, iyi hareketlilik`,
        );
        if (Number.isFinite(adxNow)) {
          const dir = trend === "UP" ? "yükseliş trendi" : trend === "DOWN" ? "düşüş trendi" : "trend";
          reasons.push(adxNow >= 25 ? `güçlü ${dir}` : "trend zayıf (yatay)");
        }
        if (rec) reasons.push(`örneklem dışı karne: ${describeTrack(rec).text}`);

        out.push({
          symbol: t.symbol,
          price: t.price,
          changePct: t.changePct,
          quoteVolume: t.quoteVolume,
          rangePct,
          atrPct,
          adx: Number.isFinite(adxNow) ? adxNow : null,
          trend,
          score,
          label: score >= 70 ? "Çok uygun" : score >= 55 ? "Uygun" : score >= 40 ? "Orta" : "Zayıf",
          reason: reasons.join(", "),
        });
      } catch {
        /* bu coin için veri alınamadı, sonraki turda tekrar denenir */
      }
    }
    this.list = out.sort((a, b) => b.score - a.score);
    this.emit("updated", this.list);
  }
}
