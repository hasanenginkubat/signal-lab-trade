"use client";

import { useEffect, useRef } from "react";
import { ColorType, LineSeries, LineStyle, createChart, type UTCTimestamp } from "lightweight-charts";
import type { LivePoint } from "@signal-lab/shared";

const TZ_OFFSET_S = typeof window === "undefined" ? 0 : -new Date().getTimezoneOffset() * 60;

/** Üç çizgili bakiye eğrisi: Bot / BTC al-tut / Sepet al-tut (başlangıç = 100) */
export function LiveChart({ points }: { points: LivePoint[] }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current || points.length === 0) return;
    const chart = createChart(ref.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "#131722" }, textColor: "#8a91a5", fontSize: 11 },
      grid: { vertLines: { color: "rgba(42,46,57,0.4)" }, horzLines: { color: "rgba(42,46,57,0.4)" } },
      rightPriceScale: { borderColor: "#252a37" },
      timeScale: { borderColor: "#252a37", timeVisible: true },
      localization: { locale: "tr-TR" },
    });
    const fmt = { type: "price" as const, precision: 2, minMove: 0.01 };
    const bot = chart.addSeries(LineSeries, { color: "#0ecb81", lineWidth: 2, priceFormat: fmt, title: "Bot" });
    const btc = chart.addSeries(LineSeries, { color: "#f0b90b", lineWidth: 2, priceFormat: fmt, title: "BTC al-tut" });
    const basket = chart.addSeries(LineSeries, { color: "#5b8def", lineWidth: 2, lineStyle: LineStyle.Dashed, priceFormat: fmt, title: "Sepet al-tut" });

    // Zaman damgaları saniye bazında benzersiz ve artan olmalı (aynı saniyede son değer)
    const bySec = new Map<number, LivePoint>();
    for (const p of points) bySec.set(Math.floor(p.time / 1000) + TZ_OFFSET_S, p);
    const rows = [...bySec.entries()].sort((a, b) => a[0] - b[0]);
    bot.setData(rows.map(([t, p]) => ({ time: t as UTCTimestamp, value: p.bot })));
    btc.setData(rows.map(([t, p]) => ({ time: t as UTCTimestamp, value: p.btc })));
    basket.setData(rows.map(([t, p]) => ({ time: t as UTCTimestamp, value: p.basket })));
    bot.createPriceLine({ price: 100, color: "rgba(138,145,165,0.6)", lineStyle: LineStyle.Dotted, lineWidth: 1, axisLabelVisible: false, title: "Başlangıç" });
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [points]);

  return <div ref={ref} className="equity-chart" />;
}
