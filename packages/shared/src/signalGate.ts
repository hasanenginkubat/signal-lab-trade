import type { ConsensusLabel, SignalQuality, TechnicalAnalysis, TrackRecord } from "./types";

/** Oranların gösterilmesi için gereken en az işlem sayısı */
export const MIN_TRADES_FOR_STATS = 30;

/**
 * TEK etiket kaynağı. Orta panel, sağ panel, coin listesi ve bildirimler bu fonksiyonu kullanır.
 * AL / GÜÇLÜ AL yalnızca kapı geçildiğinde; skor yüksek ama kapı geçilmediyse İZLE ("güçlü görünüm").
 */
export function consensusLabel(
  score: number,
  threshold: number,
  gate: { passed: boolean; quality: SignalQuality | null; side?: "LONG" | "SHORT" | null } | null,
  allowShort: boolean,
): ConsensusLabel {
  if (gate?.passed) {
    if (gate.side === "SHORT") return gate.quality === "A+" ? "GÜÇLÜ SAT" : "SAT";
    return gate.quality === "A+" ? "GÜÇLÜ AL" : "AL";
  }
  if (score >= threshold) return "İZLE";
  if (score <= -threshold) return allowShort ? "BEKLE" : "UZAK DUR";
  return "BEKLE";
}

/** Etiketin ekranda gösterilecek metni */
export const LABEL_TEXT: Record<ConsensusLabel, string> = {
  "GÜÇLÜ AL": "GÜÇLÜ AL",
  AL: "AL",
  "İZLE": "Güçlü görünüm",
  BEKLE: "BEKLE",
  "UZAK DUR": "Uzak dur",
  SAT: "SAT",
  "GÜÇLÜ SAT": "GÜÇLÜ SAT",
};

/** Gerçek (işlem yapılabilir) sinyal mi */
export function isTradeLabel(label: ConsensusLabel): boolean {
  return label === "AL" || label === "GÜÇLÜ AL" || label === "SAT" || label === "GÜÇLÜ SAT";
}

/** "Bu planı emir paneline aktar" yalnızca kapıdan geçmiş bir planda gösterilir */
export function canOfferPlan(a: Pick<TechnicalAnalysis, "plan" | "verdict"> | null | undefined): boolean {
  return !!a?.plan && (a.verdict === "BUY" || a.verdict === "STRONG_BUY");
}

/** Karne metni: n < 30 ise oran yerine "yetersiz veri" */
export function describeTrack(r: TrackRecord | null | undefined): { sufficient: boolean; text: string } {
  if (!r || r.trades === 0) return { sufficient: false, text: "veri yok" };
  if (r.trades < MIN_TRADES_FOR_STATS) return { sufficient: false, text: `yetersiz veri (n=${r.trades})` };
  return {
    sufficient: true,
    text: `%${r.winRatePct.toFixed(0)} kazanç • %${r.breakevenPct.toFixed(0)} başa baş • %${r.lossPct.toFixed(0)} kayıp (n=${r.trades})`,
  };
}

// ---------- Seçici mod (sadece A+) ----------

/**
 * Seçici mod açıkken yalnızca A+ konsensüs sinyalleri bildirim ve işlem butonu alır;
 * A kalite sinyaller listede "A (izle)" olarak bilgi amaçlı kalır.
 */
export function isActionableSignal(s: { kind?: string; quality?: string | null }, onlyAPlus: boolean): boolean {
  return !onlyAPlus || s.kind !== "consensus" || s.quality === "A+";
}

/** Listede gösterilecek kalite etiketi */
export function qualityTag(quality: string | null | undefined, onlyAPlus: boolean): string | null {
  if (!quality) return null;
  return quality === "A" && onlyAPlus ? "A (izle)" : quality;
}

/**
 * Kayıtlı arayüz ayarlarını geri yükler. Seçici mod KALICI DEĞİLDİR: her açılışta (sayfa yenileme,
 * sunucu yeniden başlatma) sunucunun varsayılanına (A+) döner; kullanıcı yalnızca o oturum için kapatabilir.
 */
export function restoreSettings<T extends { onlyAPlus: boolean }>(defaults: T, saved: Partial<T> | null | undefined, aPlusOnlyDefault: boolean): T {
  const rest = { ...(saved ?? {}) } as Record<string, unknown>;
  delete rest.onlyAPlus;
  return { ...defaults, ...(rest as Partial<T>), onlyAPlus: aPlusOnlyDefault };
}

/** Tarayıcıya yazılacak ayarlar (seçici mod hariç) */
export function persistableSettings<T extends { onlyAPlus: boolean }>(s: T): Omit<T, "onlyAPlus"> {
  const { onlyAPlus: _skip, ...rest } = s;
  return rest;
}
