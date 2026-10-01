"use client";

import { useEffect, useRef } from "react";
import { AreaSeries, ColorType, LineSeries, LineStyle, createChart, type UTCTimestamp } from "lightweight-charts";
import type { EquityPoint } from "@signal-lab/shared";

const TZ_OFFSET_S = typeof window === "undefined" ? 0 : -new Date().getTimezoneOffset() * 60;

export function EquityChart({ points, baseline }: { points: EquityPoint[]; baseline: number }) {
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
    const last = points[points.length - 1].equity;
    const good = last >= baseline;
    const area = chart.addSeries(AreaSeries, {
      lineColor: good ? "#0ecb81" : "#f6465d",
      topColor: good ? "rgba(14,203,129,0.28)" : "rgba(246,70,93,0.28)",
      bottomColor: "rgba(0,0,0,0)",
      lineWidth: 2,
      priceFormat: { type: "price", precision: 2, minMove: 0.01 },
      title: "Varlık",
    });
    const wallet = chart.addSeries(LineSeries, {
      color: "rgba(138,145,165,0.6)",
      lineWidth: 1,
      lineStyle: LineStyle.Dotted,
      priceLineVisible: false,
      lastValueVisible: false,
      title: "Cüzdan",
    });

    // Zaman damgaları saniye bazında benzersiz ve artan olmalı
    const seen = new Set<number>();
    const rows = points
      .map((p) => ({ ...p, t: Math.floor(p.time / 1000) + TZ_OFFSET_S }))
      .filter((p) => (seen.has(p.t) ? false : (seen.add(p.t), true)))
      .sort((a, b) => a.t - b.t);
    area.setData(rows.map((p) => ({ time: p.t as UTCTimestamp, value: p.equity })));
    wallet.setData(rows.map((p) => ({ time: p.t as UTCTimestamp, value: p.walletBalance })));
    area.createPriceLine({
      price: baseline,
      color: "rgba(240,185,11,0.6)",
      lineStyle: LineStyle.Dashed,
      lineWidth: 1,
      axisLabelVisible: true,
      title: "Başlangıç",
    });
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [points, baseline]);

  return <div ref={ref} className="equity-chart" />;
}
