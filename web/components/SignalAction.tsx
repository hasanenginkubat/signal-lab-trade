"use client";

import { useEffect, useMemo, useState } from "react";
import { describeTrack, LABEL_TEXT, qualityTag, type ConsensusLabel, type ConsensusView, type GateCheck, type GuardStatus, type Signal } from "@signal-lab/shared";
import { baseAsset, fmtPct, fmtPrice, fmtUsd } from "@/lib/format";
import { executeOneClick, minOrderFor, previewOneClick, smartAvailable, type EntryMode } from "@/lib/oneClick";
import { api } from "@/lib/api";
import { fmtDuration } from "@/lib/format";
import { notify, refreshAccount } from "@/lib/store";
import { setSettings, useStore } from "@/lib/store";

export const LABEL_CLASS: Record<ConsensusLabel, string> = {
  "GÜÇLÜ AL": "v-strong-buy",
  AL: "v-buy",
  "İZLE": "v-watch",
  BEKLE: "v-neutral",
  "UZAK DUR": "v-sell",
  SAT: "v-sell",
  "GÜÇLÜ SAT": "v-strong-sell",
};

/** −100…+100 konsensüs çubuğu. Short kapalıyken sol uç "uzak dur" olarak adlandırılır. */
export function ConsensusBar({ score }: { score: number }) {
  const allowShort = useStore((s) => s.allowShort);
  const pos = Math.min(100, Math.max(0, (score + 100) / 2));
  return (
    <div className="gauge" aria-label={`Konsensüs ${score}`}>
      <div className="gauge-bar" />
      <div className="gauge-needle" style={{ left: `${pos}%` }} />
      <div className="gauge-labels">
        <span>{allowShort ? "Güçlü sat" : "Uzak dur"}</span>
        <span>Bekle</span>
        <span>Güçlü al</span>
      </div>
    </div>
  );
}

/** Coin listesi rozeti: AL yalnızca kapıyı geçen gerçek sinyalde; yüksek skor = "Güçlü görünüm" */
export function ConsensusBadge({ view }: { view: ConsensusView | undefined }) {
  if (!view) return <span className="bias neutral">—</span>;
  const cls =
    view.label === "AL" || view.label === "GÜÇLÜ AL"
      ? "long"
      : view.label === "İZLE"
        ? "watch"
        : view.label === "UZAK DUR" || view.label === "SAT" || view.label === "GÜÇLÜ SAT"
          ? "short"
          : "neutral";
  return (
    <span
      className={`bias ${cls}`}
      title={`${LABEL_TEXT[view.label]} • konsensüs %${view.score} • ${view.agree}/${view.total} bileşen${view.passed ? " • sinyal kapısı geçti" : view.blockedBy ? ` • ${view.blockedBy}` : ""}`}
    >
      {view.label === "İZLE" ? "İZLE" : view.label} <span className="num">{view.score > 0 ? "+" : ""}{view.score}</span>
    </span>
  );
}

/** Sinyal kapısının kontrolleri (✓ geçti / ✗ geçmedi) */
export function GateChecks({ checks }: { checks: GateCheck[] }) {
  if (!checks.length) return null;
  return (
    <ul className="quality-notes gate-checks">
      {checks.map((c) => (
        <li key={c.key} className={c.ok ? "yes" : "no"} title={c.detail}>
          {c.label} <span className="faint">— {c.detail}</span>
        </li>
      ))}
    </ul>
  );
}

/** Risk kalkanı durumunu hesap değiştikçe ve 20 sn'de bir tazeler. */
export function useGuard(): GuardStatus | null {
  const [guard, setGuard] = useState<GuardStatus | null>(null);
  const version = useStore((s) => `${s.account?.positions.length}:${s.account?.orders.length}:${s.tradesVersion}`);
  useEffect(() => {
    let cancelled = false;
    const load = () => api.guard().then((g) => !cancelled && setGuard(g)).catch(() => {});
    void load();
    const t = setInterval(load, 20_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [version]);
  return guard;
}

export function GuardBanner({ guard }: { guard: GuardStatus }) {
  if (!guard.enabled) return null;
  return (
    <div className={`guard ${guard.canTrade ? "ok" : "block"}`}>
      <b>🛡️ Risk kalkanı: {guard.canTrade ? "işlem açılabilir" : "yeni işlem durduruldu"}</b>
      <span className="num">
        Pozisyon {guard.openPositions}/{guard.maxOpen} • Bugün kayıp {guard.lossesToday}/{guard.dayStopLosses} • Seri{" "}
        {guard.consecutiveLosses}/{guard.breakerLosses} • BTC günlük{" "}
        {guard.btcDailyTrend === "UP" ? "▲" : guard.btcDailyTrend === "DOWN" ? "▼" : "▬"}
      </span>
      {guard.reasons.map((r) => (
        <span key={r} className="guard-reason">
          {r}
        </span>
      ))}
    </div>
  );
}

export function QualityBadge({ signal }: { signal: Pick<Signal, "quality" | "qualityNotes"> }) {
  const onlyAPlus = useStore((s) => s.settings.onlyAPlus);
  if (!signal.quality) return null;
  return (
    <span
      className={`quality ${signal.quality === "A+" ? "aplus" : "a"}`}
      title={`${signal.quality === "A+" ? "A+ kalite: testte en yüksek isabeti veren koşullar" : "A kalite: konsensüs var ama A+ koşullarından biri eksik"}\n• ${(signal.qualityNotes ?? []).join("\n• ")}`}
    >
      {qualityTag(signal.quality, onlyAPlus)}
    </span>
  );
}

/** 8 aylık testte A+ sinyallerde süre sınırına göre işlem başına net getiri (ücretler sonrası, iki dönem) */
export const HOLD_OPTIONS: { hours: number; label: string; note: string }[] = [
  { hours: 3, label: "3 saat", note: "Hızlı: işlem başına ~+%0.3–0.5, işlemlerin çoğu süre dolunca kapanır" },
  { hours: 6, label: "6 saat", note: "~+%0.3–0.8 / işlem" },
  { hours: 12, label: "12 saat", note: "~+%0.5–0.9 / işlem" },
  { hours: 24, label: "24 saat", note: "~+%0.6–1.0 / işlem" },
  { hours: 48, label: "48 saat", note: "En kârlı (önerilen): ~+%0.7–1.1 / işlem, genelde 5–20 saatte sonuçlanır" },
];

export function SignalAction({ symbol, onSelectSymbol }: { symbol: string; onSelectSymbol: (s: string) => void }) {
  const view = useStore((s) => s.consensus[symbol]);
  const signals = useStore((s) => s.signals);
  const settings = useStore((s) => s.settings);
  const maxLeverage = useStore((s) => s.maxLeverage);
  const mode = useStore((s) => s.mode);
  // Fiyat/hesap değiştikçe önizleme tazelensin
  useStore((s) => s.tickers[symbol]?.price);
  useStore((s) => s.account?.summary.availableBalance);
  const [busy, setBusy] = useState(false);

  const active: Signal | undefined = useMemo(
    () => signals.find((s) => s.symbol === symbol && s.status === "OPEN" && s.kind === "consensus"),
    [signals, symbol],
  );
  const others = useMemo(
    () =>
      signals
        .filter((s) => s.status === "OPEN" && s.kind === "consensus" && s.symbol !== symbol)
        .filter((s) => !settings.onlyAPlus || s.quality === "A+")
        .slice(0, 5),
    [signals, symbol, settings.onlyAPlus],
  );
  const skipped = !!active && settings.onlyAPlus && active.quality !== "A+";

  const target = active
    ? {
        symbol,
        side: active.side,
        stopLoss: active.stopLoss,
        takeProfit: active.takeProfit,
        signalId: active.id,
        entryLimit: active.entryLimit,
        entryValidUntil: active.entryValidUntil,
      }
    : null;
  const canSmart = !!target && smartAvailable(target);
  const preview = target ? previewOneClick(target, canSmart ? "smart" : "market") : null;
  const marketPreview = target ? previewOneClick(target, "market") : null;
  const long = active?.side === "LONG";
  const pending = useStore((s) => s.account?.orders.find((o) => o.symbol === symbol));
  const position = useStore((s) => s.account?.positions.find((p) => p.symbol === symbol));
  const guard = useGuard();

  async function go(mode: EntryMode) {
    if (!target) return;
    setBusy(true);
    await executeOneClick(target, mode);
    setBusy(false);
  }

  async function cancelPending() {
    if (!pending) return;
    try {
      await api.cancelOrder(pending.id);
      await refreshAccount();
    } catch (err) {
      notify("error", (err as Error).message);
    }
  }

  return (
    <div className="panel signal-action">
      {active ? (
        <>
          <div className={`verdict ${LABEL_CLASS[(active.label as ConsensusLabel) ?? "AL"] ?? "v-buy"}`}>
            <span className="verdict-label">
              {long ? "🟢" : "🔴"} {active.label ?? (long ? "AL" : "SAT")}
            </span>
            <span className="verdict-tf">
              <QualityBadge signal={active} /> {baseAsset(symbol)} • 1s
            </span>
          </div>
          {active.qualityNotes && (
            <ul className="quality-notes">
              {active.qualityNotes.map((n) => (
                <li key={n} className={/kırılım yok|Trend orta|ters yönde|uygun değil/.test(n) ? "no" : "yes"}>
                  {n}
                </li>
              ))}
            </ul>
          )}
          <div className="sa-stats num">
            <span>
              <b>%{Math.abs(active.consensus ?? 0)}</b> koşul uyumu
            </span>
            <span title="Bu kalite seviyesinin örneklem dışı (kuralların görmediği dönem) karnesi. Kazanç = yalnızca hedefe ulaşan.">
              Karne: <b>{describeTrack(active.history).text}</b>
            </span>
          </div>
          <div className="plan-row num">
            <span>Giriş</span>
            <b>{fmtPrice(active.price)}</b>
            <span className="down">Stop</span>
            <b className="down">{fmtPrice(active.stopLoss)}</b>
            <span className="up">Hedef</span>
            <b className="up">{fmtPrice(active.takeProfit)}</b>
          </div>
          {pending ? (
            <div className="pending-box num">
              <b>⏳ Akıllı giriş emri bekliyor</b>
              <span>
                Alış fiyatı {fmtPrice(pending.price)} — şu an {fmtPrice(preview?.entry ?? marketPreview?.entry)}.
                Fiyat bu seviyeye geri çekilince otomatik alınır.
              </span>
              {pending.expiresAt && (
                <span className="faint">
                  {fmtDuration(Math.max(0, pending.expiresAt - Date.now()))} içinde dolmazsa ya da fiyat hedefe kaçarsa iptal
                  edilir.
                </span>
              )}
              <button className="btn sm danger-ghost" onClick={cancelPending}>
                Emri iptal et
              </button>
            </div>
          ) : position ? (
            <div className="pending-box">
              <b>✓ Bu sinyalde pozisyonun açık</b>
              <span className="faint">Pozisyonlar sekmesinden ya da Q ile takip edebilirsin.</span>
            </div>
          ) : preview ? (
            <div className="summary-list num">
              {canSmart && (
                <div>
                  <span>Akıllı giriş fiyatı</span>
                  <span className="up">{fmtPrice(preview.entry)}</span>
                </div>
              )}
              <div>
                <span>Şu anki fiyat</span>
                <span>
                  {fmtPrice(preview.entry)}{" "}
                  <span className="faint">({fmtPct(((preview.entry - active.price) / active.price) * 100)})</span>
                </span>
              </div>
              <div>
                <span>Teminat / kaldıraç</span>
                <span>
                  {fmtUsd(preview.margin)} USDT • {preview.leverage}x
                </span>
              </div>
              <div>
                <span>Stop olursa kayıp</span>
                <span className="down">−{fmtUsd(preview.riskUsdt)} USDT</span>
              </div>
              <div title="8 aylık testte A+ işlemlerin açık kalma süresi">
                <span>Beklenen süre</span>
                <span>
                  {settings.maxHoldHours >= 24
                    ? `genelde 5–20 saat (en fazla ${settings.maxHoldHours}s)`
                    : `en fazla ${settings.maxHoldHours} saat`}
                </span>
              </div>
              <div>
                <span>Hedefe varırsa kazanç</span>
                <span className="up">+{fmtUsd(preview.riskUsdt * (active.riskReward ?? 1.5))} USDT</span>
              </div>
              {preview.leverageReduced && (
                <div className="faint" style={{ fontSize: 10 }}>
                  Likidasyon stop'tan önce gelmesin diye kaldıraç {preview.leverage}x'e düşürüldü.
                </div>
              )}
            </div>
          ) : (
            <div className="faint" style={{ fontSize: 12 }}>
              Fiyat stop seviyesini geçti, bu sinyal artık geçerli değil.
            </div>
          )}
          {skipped && (
            <div className="signal-hint" style={{ background: "var(--warn-soft)", color: "var(--warn)" }}>
              A (izle): seçici mod açık, bu sinyal yalnızca bilgi amaçlı gösteriliyor. İşlem butonu ve bildirim sadece A+
              sinyallerde çıkar (modu aşağıdan kapatabilirsiniz; sayfa yenilenince yeniden açılır).
            </div>
          )}
          {preview && !pending && !position && preview.notional < minOrderFor(symbol, preview.entry) && (
            <div className="guard block">
              <b>⚠️ Bu hesapla bu coinde işlem açılamaz</b>
              <span>
                Binance {baseAsset(symbol)} için en az {fmtUsd(minOrderFor(symbol, preview.entry))} USDT büyüklüğünde emir kabul
                ediyor; %{settings.riskPct} riskle pozisyonun {fmtUsd(preview.notional)} USDT. Bu sinyali atla — diğer coinlerde
                sorun yok. Bakiye büyüdükçe bu coin de açılır.
              </span>
            </div>
          )}
          {!pending && !position && !skipped && (
            <>
              <button
                className={`one-click ${long ? "long" : "short"}${skipped ? " muted" : ""}`}
                disabled={!preview || busy}
                onClick={() => go(canSmart ? "smart" : "market")}
                title={
                  canSmart
                    ? "Sinyal fiyatının biraz altına alış emri koyar. Testte hemen almaktan daha iyi sonuç verdi: emirlerin ~%89'u doldu, işlem başına kâr arttı."
                    : "Akıllı giriş süresi doldu; güncel fiyattan alır."
                }
              >
                {busy ? "Gönderiliyor…" : canSmart ? `AKILLI ${long ? "AL" : "SAT"}` : `TEK TIKLA ${long ? "AL" : "SAT"}`}
                <small>
                  {canSmart ? "Geri çekilmede alır • 6 saat geçerli • " : ""}
                  {mode === "binance" ? "Gerçek hesap, onay sorulur" : "Kâğıt hesap"} • SL + TP + oto başa baş
                </small>
              </button>
              {canSmart && marketPreview && (
                <button className="btn sm ghost" disabled={busy} onClick={() => go("market")} title="Beklemeden güncel fiyattan alır (testte biraz daha düşük kâr)">
                  Beklemeden hemen al ({fmtPrice(marketPreview.entry)})
                </button>
              )}
            </>
          )}
        </>
      ) : (
        <>
          <div className={`verdict ${view ? LABEL_CLASS[view.label] : "v-neutral"}`}>
            <span className="verdict-label">{view ? LABEL_TEXT[view.label] : "…"}</span>
            <span className="verdict-tf">
              {view ? `${view.agree}/${view.total} bileşen • %${view.score}` : "hesaplanıyor"}
            </span>
          </div>
          {view && <ConsensusBar score={view.score} />}
          <div className="faint" style={{ fontSize: 12, lineHeight: 1.5 }}>
            {view?.label === "UZAK DUR"
              ? "Koşulların çoğu aşağıyı gösteriyor — bu coinde alım yapmayın."
              : view?.passed
                ? "Sinyal kapısı geçti ama yeni sinyal açılmadı: bu coinde açık bir sinyal/pozisyon var ya da son işlem kapanalı 6 saat olmadı."
                : view?.blockedBy
                  ? `Sinyal yok — ${view.blockedBy}.`
                  : "Bu coinde aktif sinyal yok."}{" "}
            Kapının tüm kontrolleri geçince burada tek tıkla işlem butonu çıkar.
          </div>
          {view && <GateChecks checks={view.checks} />}
        </>
      )}

      {active?.note && (
        <details className="analyst-note">
          <summary>📝 Analist notu</summary>
          <pre>{active.note}</pre>
        </details>
      )}

      {guard && <GuardBanner guard={guard} />}

      <div className="sa-settings">
        <label className="toggle" style={{ width: "100%", fontSize: 11 }} title="Sadece A+ kalite sinyaller için bildirim gelir ve tek tık önerilir">
          <input type="checkbox" checked={settings.onlyAPlus} onChange={(e) => setSettings({ onlyAPlus: e.target.checked })} />
          Seçici mod: sadece A+ sinyaller <span className="faint">(yenileyince yeniden açılır)</span>
        </label>
        <span className="faint" style={{ width: "100%", display: "flex", alignItems: "center", gap: 6 }}>
          Süre sınırı
          <select
            className="input-sm"
            style={{ width: 82 }}
            value={settings.maxHoldHours}
            onChange={(e) => setSettings({ maxHoldHours: Number(e.target.value) })}
            aria-label="Süre sınırı"
            title={HOLD_OPTIONS.map((o) => `${o.label}: ${o.note}`).join("\n")}
          >
            {HOLD_OPTIONS.map((o) => (
              <option key={o.hours} value={o.hours}>
                {o.label}
              </option>
            ))}
          </select>
          <span style={{ fontSize: 10 }}>{HOLD_OPTIONS.find((o) => o.hours === settings.maxHoldHours)?.note}</span>
        </span>
        <span className="faint">Risk/işlem</span>
        {[0.5, 1, 2].map((r) => (
          <button key={r} className={`tb-btn ${settings.riskPct === r ? "active" : ""}`} onClick={() => setSettings({ riskPct: r })}>
            %{r}
          </button>
        ))}
        <span className="faint" style={{ marginLeft: 6 }}>
          Kaldıraç
        </span>
        <select
          className="input-sm"
          style={{ width: 58 }}
          value={settings.leverage}
          onChange={(e) => setSettings({ leverage: Number(e.target.value) })}
          aria-label="Tercih edilen kaldıraç"
        >
          {Array.from({ length: maxLeverage }, (_, k) => k + 1).map((l) => (
            <option key={l} value={l}>
              {l}x
            </option>
          ))}
        </select>
      </div>

      {others.length > 0 && (
        <div className="sa-others">
          <div className="analysis-title" style={{ marginTop: 0 }}>
            Şu an sinyali olan diğer coinler
          </div>
          {others.map((s) => (
            <button key={s.id} className="sa-other" onClick={() => onSelectSymbol(s.symbol)}>
              <span className={`side-tag ${s.side === "LONG" ? "long" : "short"}`}>{s.label ?? "AL"}</span>
              <QualityBadge signal={s} />
              <b>{baseAsset(s.symbol)}</b>
              <span className="faint num">%{Math.abs(s.consensus ?? 0)} uyum</span>

            </button>
          ))}
        </div>
      )}
    </div>
  );
}
