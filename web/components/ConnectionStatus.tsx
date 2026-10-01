"use client";

import { useStore } from "@/lib/store";

export function ConnectionStatus() {
  const socket = useStore((s) => s.socket);
  const binance = useStore((s) => s.binance);

  let cls = "ok";
  let label = "Canlı";
  if (socket !== "open") {
    cls = socket === "connecting" ? "wait" : "bad";
    label = socket === "connecting" ? "Sunucuya bağlanıyor" : "Sunucu bağlantısı yok";
  } else if (binance !== "connected") {
    cls = binance === "connecting" ? "wait" : "bad";
    label = binance === "connecting" ? "Binance'e bağlanıyor" : "Binance bağlantısı koptu";
  }

  return (
    <div className="conn" title={`Sunucu: ${socket} • Binance: ${binance}`}>
      <span className={`dot ${cls}`} />
      <span className="conn-label">{label}</span>
    </div>
  );
}
