import type { AccountState, GuardStatus, Trade, Trend } from "@signal-lab/shared";
import type { Config } from "../config";

const DAY = 86_400_000;

/**
 * Risk kalkanı. Kurallar backtest simülasyonuyla birebir aynıdır:
 *  - Aynı anda en fazla N açık pozisyon (bekleyen emirler dahil)
 *  - Gün (UTC) içinde K kayıptan sonra o gün yeni işlem yok
 *  - Üst üste M kayıp → P gün mola (mola başlayınca seri sıfırlanır)
 *  - BTC günlük trendi yukarı değilse yeni long yok (piyasa rejimi)
 */
export function computeGuard(
  account: AccountState,
  trades: Trade[],
  cfg: Config["guard"],
  btcDailyTrend: Trend | null,
  now = Date.now(),
): GuardStatus {
  // Kısmi kapatmalar ayrı satırdır: pozisyon bazında birleştir
  const byPosition = new Map<string, { pnl: number; closedAt: number }>();
  for (const t of trades) {
    const cur = byPosition.get(t.positionId);
    if (cur) {
      cur.pnl += t.realizedPnl;
      cur.closedAt = Math.max(cur.closedAt, t.closedAt);
    } else byPosition.set(t.positionId, { pnl: t.realizedPnl, closedAt: t.closedAt });
  }
  const results = [...byPosition.values()].sort((a, b) => a.closedAt - b.closedAt);

  let streak = 0;
  let pausedUntil: number | null = null;
  for (const r of results) {
    if (r.pnl < 0) {
      streak++;
      if (streak >= cfg.breakerLosses) {
        pausedUntil = r.closedAt + cfg.pauseDays * DAY;
        streak = 0;
      }
    } else streak = 0;
  }
  if (pausedUntil !== null && pausedUntil <= now) pausedUntil = null;

  const dayStart = Math.floor(now / DAY) * DAY;
  const lossesToday = results.filter((r) => r.closedAt >= dayStart && r.pnl < 0).length;
  const openPositions = account.positions.length + account.orders.length;
  const regimeOk = !cfg.requireBtcUp || btcDailyTrend === "UP";

  const reasons: string[] = [];
  if (cfg.enabled) {
    if (openPositions >= cfg.maxOpen) reasons.push(`Açık pozisyon/emir sınırı doldu (${openPositions}/${cfg.maxOpen})`);
    if (lossesToday >= cfg.dayStopLosses) reasons.push(`Bugün ${lossesToday} kayıp yaşandı — günlük limit doldu, yarın devam`);
    if (pausedUntil) reasons.push(`Üst üste ${cfg.breakerLosses} kayıp sonrası mola (${new Date(pausedUntil).toLocaleString("tr-TR")} tarihine kadar)`);
    if (!regimeOk) reasons.push(`BTC günlük trendi ${btcDailyTrend === "DOWN" ? "aşağı" : "yatay"} — piyasa rejimi long için uygun değil`);
  }

  return {
    enabled: cfg.enabled,
    canTrade: reasons.length === 0,
    reasons,
    openPositions,
    maxOpen: cfg.maxOpen,
    lossesToday,
    dayStopLosses: cfg.dayStopLosses,
    consecutiveLosses: streak,
    breakerLosses: cfg.breakerLosses,
    pausedUntil,
    btcDailyTrend,
    regimeOk,
  };
}
