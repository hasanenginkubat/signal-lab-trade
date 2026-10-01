import {
  describeTrack,
  type BacktestBand,
  type ConsensusView,
  type GuardStatus,
  type MarketReport,
  type Signal,
  type Ticker,
  type Trend,
} from "@signal-lab/shared";

const TREND_TR: Record<Trend, string> = { UP: "yükselişte", DOWN: "düşüşte", NEUTRAL: "yatay" };

function fmt(n: number): string {
  const d = n >= 1000 ? 2 : n >= 10 ? 3 : n >= 1 ? 4 : 6;
  return n.toLocaleString("tr-TR", { minimumFractionDigits: d, maximumFractionDigits: d });
}

function pct(from: number, to: number): string {
  const v = ((to - from) / from) * 100;
  return `${v >= 0 ? "+" : "−"}%${Math.abs(v).toFixed(2).replace(".", ",")}`;
}

function base(symbol: string): string {
  return symbol.replace(/USDT$/, "");
}

export interface NoteContext {
  /** Hedef yolundaki en yakın direnç (varsa) */
  resistance: number | null;
  /** Girişin altındaki en yakın destek (varsa) */
  support: number | null;
  adx: number | null;
  bands: BacktestBand[] | undefined;
}

/**
 * Bir sinyal için analist notu. Her cümle sinyalin gerçek verisinden üretilir:
 * piyasa rejimi, kurulum (hangi strateji tetiklendi), teyitler, plan, geçersizlik ve risk.
 */
export function writeSignalNote(sig: Signal, view: ConsensusView | undefined, ctx: NoteContext): string {
  const long = sig.side === "LONG";
  const items = sig.checklist ?? view?.items ?? [];
  const dir = long ? 1 : -1;
  const pro = items.filter((i) => i.vote === dir);
  const con = items.filter((i) => i.vote === -dir);
  const triggers = items.filter((i) => i.trigger && i.vote === dir);
  const entry = sig.entryLimit ?? sig.price;
  // Risk, gerçek giriş fiyatından ölçülür (akıllı girişte limit fiyatı) — broker ile aynı
  const risk = Math.abs(entry - (sig.initialStopLoss ?? sig.stopLoss));
  const lines: string[] = [];

  lines.push(`${base(sig.symbol)}/USDT — 1 saatlik ${sig.label ?? (long ? "AL" : "SAT")}${sig.quality ? ` (${sig.quality} kalite)` : ""}`);
  lines.push("");

  // Piyasa
  const daily = view?.btcDailyTrend;
  const h4 = view?.btcTrend;
  lines.push(
    `PİYASA: BTC günlükte ${daily ? TREND_TR[daily] : "belirsiz"}, 4 saatlikte ${h4 ? TREND_TR[h4] : "belirsiz"}. ` +
      (daily === "UP"
        ? "Genel risk iştahı yüksek; long kurulumları için uygun ortam."
        : daily === "DOWN"
          ? "Genel piyasa düşüşte; long işlemler testte zarar etti — bu sinyal ancak çok küçük pozisyonla değerlendirilebilir."
          : "Piyasa yön arıyor; long sinyallerin başarısı bu dönemde başa baş civarında."),
  );

  // Kurulum
  const setup: string[] = [];
  for (const t of triggers) setup.push(t.detail.replace(/^Tetiklendi: /, ""));
  lines.push(
    `KURULUM: ${setup.length ? setup.join("; ") : "Konsensüs eşiği aşıldı"}.` +
      (ctx.adx != null ? ` Trend gücü ADX ${ctx.adx.toFixed(0)} (${ctx.adx >= 25 ? "güçlü" : ctx.adx >= 18 ? "orta" : "zayıf"}).` : ""),
  );

  // Teyitler
  lines.push(
    `TEYİTLER (${pro.length}/${items.length}): ${pro.map((p) => p.label.toLowerCase()).join(", ") || "—"}.` +
      (con.length ? ` Aleyhte: ${con.map((c) => c.label.toLowerCase()).join(", ")}.` : " Aleyhte koşul yok."),
  );

  // Plan
  const bePrice = entry + dir * risk;
  const stop = sig.initialStopLoss ?? sig.stopLoss;
  lines.push(
    `PLAN (sinyal mumunun kapanışı ${fmt(sig.price)} referans): zarar kes ${fmt(stop)} (${pct(sig.price, stop)}), ` +
      `hedef ${fmt(sig.takeProfit)} (${pct(sig.price, sig.takeProfit)}), risk/ödül 1:${(sig.riskReward ?? 1.5).toFixed(2).replace(".", ",")}.` +
      (sig.entryLimit
        ? ` Akıllı giriş: ${fmt(entry)}'de limit emir (6 saat geçerli; dolmadan fiyat hedefe giderse iptal).`
        : "") +
      ` Fiyat ${fmt(bePrice)} seviyesine ulaşınca stop girişe çekilir; bundan sonra en kötü ihtimalle ücret + kayma kadar (~%0,14) eksiyle kapanır.`,
  );

  // Geçersizlik
  const inv: string[] = [`Saatlik kapanış ${fmt(sig.initialStopLoss ?? sig.stopLoss)} ${long ? "altına" : "üstüne"} inerse senaryo bozulur`];
  if (ctx.resistance && (long ? ctx.resistance < sig.takeProfit && ctx.resistance > entry : ctx.resistance > sig.takeProfit && ctx.resistance < entry)) {
    inv.push(`hedef yolunda ${fmt(ctx.resistance)} ${long ? "direnci" : "desteği"} var — burada satış baskısı görülebilir`);
  }
  if (ctx.support && long) inv.push(`en yakın destek ${fmt(ctx.support)}`);
  lines.push(`GEÇERSİZLİK: ${inv.join("; ")}.`);

  // Süre (8 aylık testte A+ / BTC yükselişte / akıllı giriş: 323 işlem)
  lines.push(
    "SÜRE: Akıllı giriş emri genelde ilk 1 saatte dolar (%84), en geç 6 saatte iptal olur. Pozisyon genelde 5–20 saat açık kalır " +
      "(ortanca 10 saat; %80'i 24 saat içinde sonuçlanır). 48 saatte sonuçlanmazsa zaman stopu ile otomatik kapatılır — " +
      "ekran başında beklemenize gerek yok, stop ve hedef emirleri sizin yerinize çalışır.",
  );

  // Risk
  const band = ctx.bands?.find((b) => b.label === (sig.quality ?? "A"));
  const track = describeTrack(band);
  lines.push(
    `RİSK: Bakiyenin en fazla %1'i. ` +
      (band && track.sufficient
        ? `Bu tür (${sig.quality}) sinyallerin örneklem dışı karnesi: ${track.text}; işlem başına ${band.expectancyPct >= 0 ? "+" : ""}%${band.expectancyPct.toFixed(2).replace(".", ",")} (ücret + kayma sonrası). `
        : `Bu tür (${sig.quality ?? "A"}) sinyallerin örneklem dışı karnesi: ${track.text}. `) +
      "Arka arkaya birkaç kayıp normaldir; tek işleme fazla anlam yüklemeyin.",
  );
  return lines.join("\n");
}

/** Günlük piyasa raporu: rejim, en güçlü/zayıf coinler, aktif sinyaller ve risk kalkanı. */
export function writeMarketReport(
  views: ConsensusView[],
  signals: Signal[],
  guard: GuardStatus,
  btc: Ticker | undefined,
  now = Date.now(),
): MarketReport {
  const btcView = views.find((v) => v.symbol === "BTCUSDT");
  const daily = btcView?.btcDailyTrend ?? guard.btcDailyTrend;
  const h4 = btcView?.btcTrend ?? null;

  const regime: MarketReport["regime"] =
    daily === "UP" && h4 !== "DOWN"
      ? { label: "UYGUN", tone: "bull", text: "BTC günlük ve 4 saatlikte yükselişte. Sistemin test edildiği en iyi ortam: A+ sinyaller değerlendirilebilir." }
      : daily === "UP"
        ? { label: "TEMKİNLİ", tone: "neutral", text: "BTC günlükte yükselişte ama 4 saatlikte geri çekiliyor. A+ sinyaller seçici şekilde, tam risk yerine yarım riskle değerlendirilebilir." }
        : { label: "UYGUN DEĞİL", tone: "bear", text: `BTC günlükte ${daily ? TREND_TR[daily] : "belirsiz"}. 8 aylık testte bu ortamda long sinyaller zarar etti. Bugün yeni işlem açmamak en iyisi — nakit de bir pozisyondur.` };

  const sorted = [...views].sort((a, b) => b.score - a.score);
  const top = sorted.filter((v) => v.score >= 50).slice(0, 6);
  const avoid = sorted.filter((v) => v.score <= -50).reverse().slice(0, 6);
  const bullish = views.filter((v) => v.score >= 70).length;
  const bearish = views.filter((v) => v.score <= -70).length;
  const avg = views.length ? Math.round(views.reduce((a, v) => a + v.score, 0) / views.length) : 0;
  const active = signals.filter((s) => s.status === "OPEN" && s.kind === "consensus").sort((a, b) => b.createdAt - a.createdAt);
  const activeAPlus = active.filter((s) => s.quality === "A+");

  const headline =
    regime.label === "UYGUN DEĞİL"
      ? "Bugün bekleme günü: piyasa rejimi long işlemler için uygun değil"
      : activeAPlus.length
        ? `${activeAPlus.length} aktif A+ sinyal var — planlara sadık kalın`
        : "Piyasa uygun, A+ sinyal bekleniyor";

  const paragraphs: string[] = [];
  paragraphs.push(
    `BTC ${btc ? `${fmt(btc.price)} (${btc.changePct >= 0 ? "+" : "−"}%${Math.abs(btc.changePct).toFixed(2).replace(".", ",")}, 24s)` : ""} — ${regime.text}`,
  );
  paragraphs.push(
    `Genel tablo (${views.length} coin): AL bölgesinde ${bullish}, SAT bölgesinde ${bearish} coin var; ortalama konsensüs %${avg}. ` +
      (avg >= 30 ? "Piyasa genelinde alıcılar baskın." : avg <= -30 ? "Piyasa genelinde satıcılar baskın." : "Piyasa genelinde kararsızlık var."),
  );
  if (top.length) {
    paragraphs.push(
      `En güçlü görünenler: ${top
        .slice(0, 4)
        .map((v) => `${base(v.symbol)} (%${v.score}${v.quality === "A+" ? ", A+" : ""})`)
        .join(", ")}. ` + (top[0].blockedBy ? `Lider coinde sinyal durumu: ${top[0].blockedBy.toLowerCase()}.` : ""),
    );
  }
  if (avoid.length) {
    paragraphs.push(`Uzak durulacaklar: ${avoid.slice(0, 4).map((v) => `${base(v.symbol)} (%${v.score})`).join(", ")} — koşulların çoğu aşağıyı gösteriyor, alım yapmayın.`);
  }
  if (activeAPlus.length) {
    paragraphs.push(
      `Aktif A+ sinyaller: ${activeAPlus
        .slice(0, 5)
        .map((s) => `${base(s.symbol)} giriş ${fmt(s.entryLimit ?? s.price)}, stop ${fmt(s.stopLoss)}, hedef ${fmt(s.takeProfit)}`)
        .join("; ")}.`,
    );
  }
  paragraphs.push(
    guard.canTrade
      ? `Risk kalkanı: ${guard.openPositions}/${guard.maxOpen} pozisyon, bugün ${guard.lossesToday}/${guard.dayStopLosses} kayıp — yeni işlem açılabilir.`
      : `Risk kalkanı yeni işlemi engelliyor: ${guard.reasons.join("; ")}.`,
  );
  paragraphs.push(
    "Kurallar: sadece A+ sinyaller, işlem başına bakiyenin %1'i, en fazla 5 açık pozisyon, günde 2 kayıptan sonra dur, üst üste 4 kayıpta 3 gün mola. Stop'u asla genişletmeyin.",
  );

  const date = new Date(now).toLocaleString("tr-TR", { dateStyle: "long", timeStyle: "short" });
  const text = [`SIGNAL LAB — GÜNLÜK RAPOR (${date})`, "", `Piyasa rejimi: ${regime.label}`, headline, "", ...paragraphs].join("\n");

  return { generatedAt: now, regime, headline, paragraphs, top, avoid, activeSignals: active.slice(0, 10), guard, text };
}
